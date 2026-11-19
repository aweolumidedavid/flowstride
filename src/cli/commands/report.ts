import { loadNativeConfig } from '../../ci/config';
import { historyCatalog, startRunHistoryServer } from '../../reporting/run_history_server';
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

export async function reportAction(options: { open?: boolean; legacy?: boolean } = {}) {
  try {
    if (options.legacy) return await openLegacyReport();
    const root = process.cwd();
    const config = loadNativeConfig(root, {});
    if (options.open !== false && !historyCatalog(root, config.artifactsDir).length &&
        fs.existsSync(path.join(root, 'reports', 'latest', 'run-data.json'))) {
      await openLegacyReport();
      return;
    }
    const { server, url } = await startRunHistoryServer(root, config.artifactsDir);
    const stop = () => { server.close(); server.closeAllConnections(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.once('close', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
    console.log('Flowstride saved runs at ' + url);
    if (options.open !== false) {
      try {
        const { default: open } = await import('open');
        await open(url);
      } catch {
        console.error('Open the saved runs URL in your browser.');
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not start the local reports server.');
    process.exitCode = 1;
  }
}

async function openLegacyReport() {
  console.log("📊 Flowstride: Launching Debug Dashboard...");

  const targetProjectPath = process.cwd();
  const latestReportPath = path.join(targetProjectPath, "reports", "latest");

  const cliInstallPath = path.resolve(__dirname, "../../..");
  const reportPackagePath = path.join(
    cliInstallPath,
    "packages",
    "flowstride_report",
  );
  const publicPath = path.join(reportPackagePath, "public");

  const runDataPath = path.join(latestReportPath, "run-data.json");
  if (!fs.existsSync(runDataPath)) {
    console.error(
      '❌ Error: No run data found. Run "flowstride run" first to generate a report.',
    );
    return;
  }

  if (!fs.existsSync(publicPath)) {
    fs.mkdirSync(publicPath, { recursive: true });
  }

  fs.copyFileSync(runDataPath, path.join(publicPath, "run-data.json"));

  const sourceScreenshots = path.join(latestReportPath, "screenshots");
  const targetScreenshots = path.join(publicPath, "screenshots");

  if (fs.existsSync(sourceScreenshots)) {
    if (!fs.existsSync(targetScreenshots)) {
      fs.mkdirSync(targetScreenshots, { recursive: true });
    }

    const files = fs.readdirSync(sourceScreenshots);
    for (const file of files) {
      fs.copyFileSync(
        path.join(sourceScreenshots, file),
        path.join(targetScreenshots, file),
      );
    }
    console.log(`📸 Synced ${files.length} screenshots to dashboard.`);
  }

  try {
    console.log("Serving report at http://localhost:5173...");
    execSync("npm run dev", {
      cwd: reportPackagePath,
      stdio: "inherit",
    });
  } catch (error) {
    console.error("❌ CLI Error: Could not launch report dashboard.");
  }
}
