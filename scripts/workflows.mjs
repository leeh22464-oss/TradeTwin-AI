import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = fileURLToPath(new URL('../', import.meta.url));
dotenv.config({ path: resolve(root, '.env'), quiet: true });
const windows = process.platform === 'win32';
const mode = process.argv[2] || 'dev';
const install = 'python -m pip install -r workflow-1/app/requirements.txt';

function port(value, label) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }
  return Number(value);
}

function workflowOrigin() {
  let url;
  try { url = new URL(process.env.WORKFLOW1_URL || 'http://127.0.0.1:8000'); }
  catch { throw new Error('WORKFLOW1_URL must be a loopback HTTP origin, for example http://127.0.0.1:8000.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('WORKFLOW1_URL must be a loopback HTTP origin; remote targets, credentials and paths are not supported.');
  }
  // Both managed APIs bind IPv4 loopback. Normalize localhost/::1 to the same
  // address so clients cannot accidentally resolve a different loopback family.
  return `http://127.0.0.1:${port(url.port || 80, 'WORKFLOW1_URL port')}`;
}

function python() {
  const explicit = process.env.WORKFLOW1_PYTHON?.trim();
  const venv = resolve(root, '.venv', windows ? 'Scripts/python.exe' : 'bin/python');
  const candidates = explicit ? [[explicit]] : [
    ...(existsSync(venv) ? [[venv]] : []), ['python'], ['python3'], ...(windows ? [['py', '-3']] : []),
  ];
  for (const [command, ...args] of candidates) {
    const version = spawnSync(command, [...args, '--version'], { cwd: root, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    const match = `${version.stdout || ''}${version.stderr || ''}`.match(/Python (\d+)\.(\d+)/);
    if (version.status !== 0 || !match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 11)) continue;
    const imports = spawnSync(command, [...args, '-c', 'import fastapi, uvicorn, httpx, pydantic'], {
      cwd: root, stdio: 'ignore', timeout: 15_000, windowsHide: true,
    });
    if (imports.status !== 0) continue;
    return { command, args };
  }
  return null;
}

async function checkPorts(ports) {
  if (new Set(ports).size !== ports.length) throw new Error('Node, Python and Vite must use distinct ports.');
  for (const number of ports) {
    await new Promise((done, reject) => {
      const server = createServer();
      server.once('error', () => reject(new Error(`Loopback port ${number} is unavailable. Stop its service or choose another port in .env.`)));
      server.listen(number, '127.0.0.1', () => server.close(done));
    });
  }
}

async function killTree(pid) {
  if (!pid) return;
  if (windows) {
    await new Promise((done) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      const finish = () => {
        // Restricted desktops can deny taskkill's process enumeration. These
        // PIDs are owned children; their containing job handles descendants.
        try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ }
        done();
      };
      killer.once('error', finish);
      killer.once('close', finish);
    });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* Already stopped. */ }
  await new Promise((done) => setTimeout(done, 1000));
  try { process.kill(-pid, 'SIGKILL'); } catch { /* No remaining descendants. */ }
}

// A Windows job closes any descendants left behind by a watcher that exits
// before taskkill can inspect its tree. The guard owns the only job handle;
// killing the guard, Ctrl-C/TERM, and normal supervisor exit all close it.
const windowsGuard = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class TradeTwinJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Run(string executable, string arguments, string directory, int parentId) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("Cannot create the Windows process job.");
    try {
      ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
      int size = Marshal.SizeOf(typeof(ExtendedLimits));
      IntPtr info = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits, info, false);
        if (!SetInformationJobObject(job, 9, info, (uint)size)) throw new Exception("Cannot configure Windows process cleanup.");
      } finally { Marshal.FreeHGlobal(info); }
      ProcessStartInfo start = new ProcessStartInfo(executable, arguments);
      start.UseShellExecute = false; start.WorkingDirectory = directory;
      using (Process parent = Process.GetProcessById(parentId))
      using (Process child = Process.Start(start)) {
        if (!AssignProcessToJobObject(job, child.Handle)) {
          child.Kill(); child.WaitForExit();
          throw new Exception("Cannot supervise the Windows process tree.");
        }
        // Also closes the job after abrupt parent termination, when Node has
        // no opportunity to forward a signal to this guard.
        while (!child.WaitForExit(250)) {
          if (parent.HasExited) return 0;
        }
        return child.ExitCode;
      }
    } finally { CloseHandle(job); }
  }
}
'@
try {
  $result = [TradeTwinJob]::Run($env:TRADETWIN_JOB_NODE, $env:TRADETWIN_JOB_ARGS, $env:TRADETWIN_JOB_CWD, [int]$env:TRADETWIN_JOB_PARENT)
  exit $result
} catch {
  [Console]::Error.WriteLine("TradeTwin Windows process supervision failed.")
  exit 1
}
`;

function quoteWindows(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

async function guardedWindows() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsGuard, 'utf16le').toString('base64')], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, TRADETWIN_JOB_NODE: process.execPath,
      TRADETWIN_JOB_ARGS: [fileURLToPath(import.meta.url), mode, '--windows-job-child'].map(quoteWindows).join(' '),
      TRADETWIN_JOB_CWD: root, TRADETWIN_JOB_PARENT: String(process.pid) },
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await killTree(child.pid);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.once('error', () => { console.error('Unable to start Windows process supervision with PowerShell.'); process.exitCode = 1; });
  child.once('exit', (code) => { if (!stopping) process.exitCode = code ?? 1; });
}

async function main() {
  if (!['dev', 'start'].includes(mode)) throw new Error('Usage: node scripts/workflows.mjs dev|start');
  const nodePort = port(process.env.PORT || 3001, 'PORT');
  const vitePort = port(process.env.VITE_PORT || 5173, 'VITE_PORT');
  const workflow1 = workflowOrigin();
  const pythonPort = port(new URL(workflow1).port, 'WORKFLOW1_URL port');
  const interpreter = python();
  const apiFile = resolve(root, mode === 'dev' ? 'node_modules/tsx/dist/cli.mjs' : 'dist-server/index.js');
  if (!existsSync(apiFile)) throw new Error(mode === 'start' ? 'Production build missing. Run npm run build before npm start.' : 'Node dependencies missing. Run npm install.');
  if (mode === 'start' && !existsSync(resolve(root, 'dist/index.html'))) throw new Error('Frontend build missing. Run npm run build before npm start.');
  if (mode === 'dev' && !existsSync(resolve(root, 'node_modules/vite/bin/vite.js'))) throw new Error('Vite is missing. Run npm install.');
  await checkPorts([nodePort, ...(interpreter ? [pythonPort] : []), ...(mode === 'dev' ? [vitePort] : [])]);
  if (windows && !process.argv.includes('--windows-job-child')) return guardedWindows();

  const nodeOrigin = `http://127.0.0.1:${nodePort}`;
  const env = { ...process.env, PORT: String(nodePort), VITE_PORT: String(vitePort),
    WORKFLOW1_URL: workflow1, WORKFLOW2_MODE: 'http', WORKFLOW2_URL: `${nodeOrigin}/api/workflow2` };
  const children = [];
  let stopping = false;
  const stop = async (code) => {
    if (stopping) return;
    stopping = true;
    await Promise.all(children.map((child) => killTree(child.pid)));
    process.exit(code);
  };
  process.on('SIGINT', () => void stop(0));
  process.on('SIGTERM', () => void stop(0));
  function launch(name, command, args, cwd = root) {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true, detached: !windows });
    children.push(child);
    child.once('error', () => {
      console.error(`${name} could not start. Check the interpreter and installed dependencies.`);
      void stop(1);
    });
    child.once('exit', (code, signal) => {
      if (!stopping) {
        console.error(`${name} exited unexpectedly (${signal || `exit code ${code}`}); stopping all workflow services.`);
        void stop(1);
      }
    });
  }
  if (interpreter) launch('Python API', interpreter.command, [...interpreter.args, '-m', 'uvicorn', 'tradetwin.server:app', '--host', '127.0.0.1', '--port', String(pythonPort)], resolve(root, 'workflow-1/app'));
  else console.warn(`Python 工作流一未启动；主询盘工作台仍可用。需要兼容桥接时安装 Python 3.11+ 及依赖：${install}`);
  launch('Node API', process.execPath, mode === 'dev' ? [apiFile, 'watch', 'server/index.ts'] : [apiFile]);
  if (mode === 'dev') launch('Vite', process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort']);
  console.log(`Starting both workflows. API: ${nodeOrigin}; Python: ${workflow1}; workspace: ${mode === 'dev' ? `http://127.0.0.1:${vitePort}` : nodeOrigin}`);
  console.log('Press Ctrl-C to stop every managed service.');
}

main().catch((error) => { console.error(`TradeTwin startup failed: ${error.message}`); process.exitCode = 1; });
