export interface FlowstrideConfig {
  protectedHandoff?: boolean;
  /** Dashboard frames may come from the owned local practice server during this run. */
  practiceDashboardOrigin?: string;
  /** Internal run plan: immutable dataset and fragment fingerprints, never row values. */
  nativeDataManifest?: Record<string,string>;
  scenarioTags?: string[];
  browser?: 'chromium' | 'firefox' | 'webkit';
  browserOptions?: import('playwright').BrowserContextOptions;
  retries?: number;
  failOnFlaky?: boolean;
  trace?: boolean;
  har?: boolean;
  domSnapshots?: boolean;
  shard?: string;
  shardHistory?: string;
  updateBaselines?: boolean;

  ci?: boolean;
  flowRoot?: string;
  projectRoot?: string;
  cloudSyncResult?: { reporting: string; video: string; error?: unknown };
  device?: 'desktop' | 'phone' | 'landscape';
  viewport?: { width: number; height: number };
  testDir?: string;
  practiceApp?: boolean;
  artifactsDir?: string;
  recordVideo?: boolean;
  browserErrors?: 'fail' | 'record';
  webServer?: { command: string; url: string; cwd?: string; timeout?: number };
  testFile?: string;
  onRunEvent?: (event: any) => void;
  bail?: boolean;
  isCloudSyncActive?: boolean;
  machineToken?: string | null;
  workspaceId?: string | null;
  manifest?: { plan?: string; maxWorkers?: number | 'unlimited'; [key: string]: any } | null;
  baseUrl?: string;
  timeout: number;
  headless: boolean;
  defaultDialogBehavior?: 'accept' | 'dismiss';
  urlMapPath?: string;
  network?: {
    include?: string[];
    exclude?: string[];
    backgroundPatterns?: string[];
  };
  security?: {
    sensitiveKeys?: string[];
    evidence?: { screenshots?: boolean; cloudVideo?: boolean };
  };
  pluginsDir?: string;
  helpersDir?: string;
}

export interface SessionData {
  name: string;
  tokens: Record<string, any>;
  cookies?: any[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  storageOrigin?: string;
  createdAt: number;
  lastUsedAt: number;
  persist: boolean;
}

export interface SessionDefinition {
  name: string;
  acquire: () => Promise<Record<string, any>>;
  inject?: {
    api?: {
      headerName: string;
      template: string;
    };
    ui?: {
      localStorage?: Record<string, string>;
      cookies?: Array<{ name: string; value: string; domain: string }>;
    };
  };
  refresh?: {
    onStatus: number[];
    action: (oldTokens: any) => Promise<Record<string, any>>;
  };
}

export type FixtureTeardown = (signal: AbortSignal) => void | Promise<void>;

export interface FixtureContext {
  readonly baseURL?: string;
  /** One-based scenario attempt when using flow.fixture.use. */
  readonly attempt?: number;
  /** Cancels asynchronous setup when the runner stops or the setup times out. */
  readonly signal: AbortSignal;
  /** Register the release function immediately after acquiring a resource. */
  defer(release: FixtureTeardown, options?: { handoff: string }): void;
  /** Request an isolated browser profile for this scenario attempt. */
  profile(name: string, options?: import('playwright').BrowserContextOptions): void;
}

export interface FlowstrideSDK {
  game: import('../game/sdk').GameSDK;
  browser: { page: () => import('playwright').Page };
  run: { device: string; artifactsDir: string; attach: (name: string, data: string | Buffer) => string };

  api: {
    get: (url: string, headers?: Record<string, string>) => Promise<any>;
    post: (url: string, body: any, headers?: Record<string, string>) => Promise<any>;
    put: (url: string, body: any, headers?: Record<string, string>) => Promise<any>;
    patch: (url: string, body: any, headers?: Record<string, string>) => Promise<any>;
    delete: (url: string, headers?: Record<string, string>) => Promise<any>;
  };
  ui: {
    click: (selector: string) => Promise<void>;
    type: (selector: string, text: string) => Promise<void>;
    isVisible: (selector: string) => Promise<boolean>;
    getText: (selector: string) => Promise<string>;
  };
  state: {
    get: (key: string) => any;
    set: (key: string, value: any) => void;
    delete: (key: string) => void;
    clear: () => void;
  };
  env: {
    get: (key: string) => string | undefined;
  };
  db: {
    connect: (connectionString: string) => any;
  };
  otp: {
    generate: (secret: string) => string;
  };
  log: (message: string) => void;
  expect: {
    visible: (selector: string) => Promise<boolean>;
    equals: (actual: any, expected: any, message?: string) => void;
    contains: (actual: string | any[], expected: any, message?: string) => void;
  };
  utils: {
    sleep: (ms: number) => Promise<void>;
    generateId: (length?: number) => string;
  };
}

export type PluginAction = (flow: FlowstrideSDK, data: any) => Promise<any>;

export interface StepResult {
  id: string;
  screen: string;
  action: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED' | 'NOT TESTED';
}

export interface Scenario {
  name: string;
  steps: any[];
}

export interface ScenarioResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED' | 'NOT TESTED';
  duration: number;
  error?: string;
  steps: StepResult[];
}
