import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Lexer, TokenType } from '../parser/lexer';
import { Parser, type FeatureNode, type ScenarioNode } from '../parser/parser';
import { prepareWorkflowFeatures, scenarioSkip, selectWorkflowFeatures } from './workflow_plan';
import { handoffPattern, type HandoffCommand } from './handoff';
import { discoverFlows, flowIdentity, projectPath, selectedFeatures } from '../utils/projectPaths';
import type { FlowstrideConfig } from '../types';

export interface HandoffJob {
  file: string;
  features: FeatureNode[];
  sha256: string;
  publishes: string[];
  receives: string[];
  credentialInputs: string[];
}

interface HandoffPlan {
  root: string;
  jobs: HandoffJob[];
}

const commands = (scenario: ScenarioNode): HandoffCommand[] =>
  scenario.steps.filter(step => step.action === 'handoff').map(step => step.payload);

export function buildHandoffPlan(target: string, files: string[], config: FlowstrideConfig): HandoffPlan | undefined {
  const sources = new Map(files.map(file => [file, fs.readFileSync(file, 'utf8')]));
  if (![...sources.values()].some(source => handoffPattern.test(source))) return;

  const projectRoot = config.projectRoot || process.cwd();
  const selectedDirectory = fs.statSync(target).isDirectory();
  let root = selectedDirectory ? target : path.dirname(target);
  if (!selectedDirectory) {
    const testRoot = projectPath(projectRoot, config.testDir || 'flows');
    const relative = path.relative(testRoot, target);
    if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) && fs.existsSync(testRoot)) root = testRoot;
  }

  const parse = (source: string, candidate: boolean): FeatureNode[] => {
    if (candidate && !handoffPattern.test(source)) return [];
    const tokens = new Lexer(source).tokenise();
    if (candidate && !tokens.some(token => token.type === TokenType.ALIAS_COMMAND && handoffPattern.test(token.value))) return [];
    return new Parser(tokens).parse();
  };
  const start = new Map(files.map(file => [file, parse(sources.get(file)!, false)]));
  const selected = new Map<string, Set<ScenarioNode>>();
  for (const [file, features] of start) {
    const scenarios = selectWorkflowFeatures(features, config).flatMap(feature => feature.scenarios);
    if (scenarios.length) selected.set(file, new Set(scenarios));
  }
  const requiredCommands = (scenario: ScenarioNode) => scenarioSkip(scenario, config)
    ? commands(scenario).filter(command => command.kind === 'publish')
    : commands(scenario);
  const initial = [...selected.values()].flatMap(scenarios => [...scenarios].flatMap(requiredCommands));
  if (!initial.length) return;

  type Producer = { file: string; scenario: ScenarioNode; credentials: boolean };
  const producers = new Map<string, Producer[]>();
  const parsed = new Map(start);
  for (const file of selectedDirectory ? files : discoverFlows(root, projectRoot)) {
    if (!sources.has(file)) sources.set(file, fs.readFileSync(file, 'utf8'));
    if (!parsed.has(file)) parsed.set(file, parse(sources.get(file)!, true));
    for (const scenario of selectedFeatures(parsed.get(file)!).flatMap(feature => feature.scenarios)) {
      for (const command of commands(scenario)) if (command.kind === 'publish') {
        const owners = producers.get(command.name) || [];
        owners.push({ file, scenario, credentials: !!Object.keys(command.credentials || {}).length });
        producers.set(command.name, owners);
      }
    }
  }

  const owner = (name: string) => {
    const owners = producers.get(name) || [];
    if (!owners.length) throw new Error('Missing producer for handoff "' + name + '".');
    if (owners.length !== 1) throw new Error('Handoff "' + name + '" has more than one producer.');
    return owners[0]!;
  };
  const needed = initial.slice();
  for (let index = 0; index < needed.length; index++) {
    const command = needed[index]!;
    const { file, scenario, credentials } = owner(command.name);
    if (command.kind === 'publish') continue;
    if (command.credentialsAs && !credentials) {
      throw new Error('Handoff "' + command.name + '" does not declare any protected credentials.');
    }
    const scenarios = selected.get(file) || new Set<ScenarioNode>();
    if (!scenarios.has(scenario)) {
      scenarios.add(scenario);
      selected.set(file, scenarios);
      needed.push(...requiredCommands(scenario));
    }
  }

  const jobs = [...selected].map(([file, selection]): HandoffJob => {
    const features = prepareWorkflowFeatures(parsed.get(file)!.map(feature => ({
      ...feature, scenarios: feature.scenarios.filter(scenario => selection.has(scenario)),
    })), { ...config, scenarioTags: undefined, nativeDataManifest: config.nativeDataManifest ??= {} });
    const publishes = new Set<string>();
    const receives = new Set<string>();
    const credentialInputs = new Set<string>();
    for (const scenario of features.flatMap(feature => feature.scenarios)) for (const command of commands(scenario)) {
      if (command.kind === 'publish') {
        if (publishes.has(command.name)) throw new Error('Handoff "' + command.name + '" must publish once, including after data case expansion.');
        publishes.add(command.name);
      } else if (!scenario.skipReason) {
        if (owner(command.name).file === file) {
          throw new Error('Handoff "' + command.name + '" needs its producer and consumer in separate .flow files.');
        }
        receives.add(command.name);
        if (command.credentialsAs) credentialInputs.add(command.name);
      }
    }
    return { file, features, publishes: [...publishes], receives: [...receives], credentialInputs: [...credentialInputs],
      sha256: createHash('sha256').update(sources.get(file)!).digest('hex') };
  }).sort((a, b) => Number(!a.file.endsWith('.first.flow')) - Number(!b.file.endsWith('.first.flow')) || a.file.localeCompare(b.file));

  const graph = new Map(jobs.map(job => [job.file, new Set(job.receives.map(name => owner(name).file))]));
  const ready = [...graph].filter(([, prerequisites]) => !prerequisites.size).map(([file]) => file);
  const followers = new Map<string, string[]>();
  for (const [file, prerequisites] of graph) for (const before of prerequisites) {
    const list = followers.get(before) || [];
    list.push(file);
    followers.set(before, list);
  }
  for (let index = 0; index < ready.length; index++) for (const file of followers.get(ready[index]!) || []) {
    const remaining = graph.get(file)!;
    remaining.delete(ready[index]!);
    if (!remaining.size) ready.push(file);
  }
  if (ready.length !== jobs.length) {
    const names = [...graph].filter(([, prerequisites]) => prerequisites.size).map(([file]) => flowIdentity(file, root));
    throw new Error('Circular handoff dependencies: ' + names.join(', '));
  }
  return { root, jobs };
}

/** A connected handoff chain stays on one CI shard, which can still use parallel workers. */
export function handoffGroups(jobs: HandoffJob[]): string[][] {
  const owners = new Map(jobs.flatMap(job => job.publishes.map(name => [name, job.file] as const)));
  const adjacent = new Map(jobs.map(job => [job.file, new Set<string>()]));
  for (const job of jobs) for (const name of job.receives) {
    const owner = owners.get(name)!;
    adjacent.get(job.file)!.add(owner);
    adjacent.get(owner)!.add(job.file);
  }
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const file of adjacent.keys()) {
    if (seen.has(file)) continue;
    const members = [file];
    seen.add(file);
    for (let index = 0; index < members.length; index++) for (const linked of adjacent.get(members[index]!)!) {
      if (seen.has(linked)) continue;
      seen.add(linked);
      members.push(linked);
    }
    groups.push(members);
  }
  return groups;
}
