using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace BilibiliSubtitlePrototype
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string smokeResult = null;
            string desktopSmokeResult = null;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--no-browser") { /* The desktop UI never opens an external browser. */ }
                else if (args[i] == "--smoke-test" && i + 1 < args.Length && smokeResult == null)
                    smokeResult = args[++i];
                else if (args[i] == "--desktop-smoke-test" && i + 1 < args.Length && desktopSmokeResult == null)
                    desktopSmokeResult = args[++i];
                else return 1;
            }
            if (smokeResult != null && desktopSmokeResult != null) return 1;
            if (smokeResult != null) return SmokeTest(smokeResult);
            if (desktopSmokeResult != null && !Path.IsPathRooted(desktopSmokeResult)) return 1;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            // The regular client always embeds its UI; --no-browser remains compatible.
            DesktopWindow window = new DesktopWindow(desktopSmokeResult);
            Application.Run(window);
            return window.ResultExitCode;
        }

        private static int SmokeTest(string resultPath)
        {
            if (!Path.IsPathRooted(resultPath)) return 1;
            BackendSession session = new BackendSession();
            Stopwatch clock = Stopwatch.StartNew();
            bool ready = false, pageOk = false, graceful = false;
            string failure = null;
            long readyMs = 0;
            try
            {
                session.Start();
                ready = session.WaitForReady(90000);
                readyMs = clock.ElapsedMilliseconds;
                if (!ready) failure = session.FailureCode ?? "startup_timeout";
                else
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(session.LocalUrl);
                    request.Method = "GET";
                    request.Proxy = null;
                    request.AllowAutoRedirect = false;
                    request.Timeout = 5000;
                    request.ReadWriteTimeout = 5000;
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                        pageOk = response.StatusCode == HttpStatusCode.OK;
                    if (!pageOk) failure = "page_http_status_failed";
                }
            }
            catch (SafeFailure error) { failure = error.Code; }
            catch (WebException) { failure = "page_http_request_failed"; }
            catch { failure = "launcher_smoke_failed"; }
            finally
            {
                graceful = session.Stop(90000);
                if (!graceful && failure == null) failure = "graceful_shutdown_failed";
                session.Dispose();
            }
            bool passed = ready && pageOk && graceful && failure == null;
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["passed"] = passed;
            result["ready"] = ready;
            result["localUrl"] = session.LocalUrl;
            result["pageHttp200"] = pageOk;
            result["gracefulExit"] = graceful;
            result["nodeExitCode"] = session.ExitCode;
            result["stoppedEvent"] = session.StoppedEvent;
            result["failureCode"] = failure;
            result["readyMs"] = readyMs;
            result["totalMs"] = clock.ElapsedMilliseconds;
            result["stdoutBytes"] = session.StdoutBytes;
            result["stderrBytes"] = session.StderrBytes;
            result["browserOpened"] = false;
            result["microphoneStarted"] = false;
            result["translationSubmitted"] = false;
            result["scope"] = "launcher_start_page_http_and_graceful_shutdown_only";
            try
            {
                string fullPath = Path.GetFullPath(resultPath);
                Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
                using (FileStream stream = new FileStream(fullPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false)))
                    writer.WriteLine(new JavaScriptSerializer().Serialize(result));
            }
            catch { return 1; }
            return passed ? 0 : 1;
        }
    }

    internal sealed class LauncherWindow : Form
    {
        private readonly BackendSession session = new BackendSession();
        private readonly bool noBrowser;
        private readonly Label status = new Label();
        private readonly Button open = new Button();
        private readonly Button stop = new Button();
        private bool closing, allowClose;

        public LauncherWindow(bool suppressBrowser)
        {
            noBrowser = suppressBrowser;
            Text = "主播双语字幕 · 本机测试版";
            ClientSize = new Size(540, 178);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9F);
            status.SetBounds(20, 20, 500, 78);
            status.Text = "正在启动本地服务……\r\n不会自动开启麦克风。";
            open.SetBounds(220, 119, 145, 34);
            open.Text = "打开字幕页面";
            open.Enabled = false;
            open.Click += delegate { OpenPage(); };
            stop.SetBounds(378, 119, 142, 34);
            stop.Text = "停止并退出";
            stop.Click += delegate { Close(); };
            Controls.Add(status);
            Controls.Add(open);
            Controls.Add(stop);
            Shown += delegate { StartBackend(); };
            FormClosing += ClosingWindow;
        }

        private void OnUi(Action action)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke(action); } catch (InvalidOperationException) { }
        }

        private void StartBackend()
        {
            Thread thread = new Thread(delegate()
            {
                string failure = null;
                try
                {
                    session.Start();
                    if (!session.WaitForReady(90000)) failure = session.FailureCode ?? "startup_timeout";
                }
                catch (SafeFailure error) { failure = error.Code; }
                catch { failure = "launcher_start_failed"; }
                string code = failure;
                OnUi(delegate()
                {
                    if (closing) return;
                    if (code != null)
                    {
                        status.Text = "启动未完成：" + code + "\r\n请检查本机测试版依赖配置；不会自动重新登录。";
                        StopBackend(false);
                        return;
                    }
                    status.Text = "服务已就绪：" + session.LocalUrl + "\r\n请在页面选择模型和麦克风；点击开始后才采音。\r\n关闭本窗口会停止本次服务。";
                    open.Enabled = true;
                    if (!noBrowser) OpenPage();
                });
            });
            thread.IsBackground = true;
            thread.Start();
        }

        private void OpenPage()
        {
            if (closing || !BackendSession.ValidLocalUrl(session.LocalUrl)) return;
            try { Process.Start(new ProcessStartInfo(session.LocalUrl) { UseShellExecute = true }); }
            catch { status.Text = "浏览器打开失败：browser_open_failed\r\n可手动打开：" + session.LocalUrl; }
        }

        private void ClosingWindow(object sender, FormClosingEventArgs e)
        {
            if (allowClose) return;
            e.Cancel = true;
            if (!closing) StopBackend(true);
        }

        private void StopBackend(bool exitAfterStop)
        {
            if (closing) return;
            closing = true;
            open.Enabled = false;
            stop.Enabled = false;
            if (exitAfterStop) status.Text = "正在停止本次服务……\r\n等待已提交任务结束，最多 90 秒。";
            Thread thread = new Thread(delegate()
            {
                bool graceful = session.Stop(90000);
                session.Dispose();
                OnUi(delegate()
                {
                    if (exitAfterStop) { allowClose = true; Close(); }
                    else
                    {
                        status.Text += graceful ? "\r\n本次服务已停止。" : "\r\n已执行本次进程树的兜底清理。";
                        allowClose = true;
                        stop.Text = "退出";
                        stop.Enabled = true;
                    }
                });
            });
            thread.IsBackground = true;
            thread.Start();
        }
    }

    internal sealed class SafeFailure : Exception
    {
        public readonly string Code;
        public SafeFailure(string code) : base(code) { Code = code; }
    }

    internal sealed class BackendSession : IDisposable
    {
        private readonly object launchLock = new object();
        private readonly object stateLock = new object();
        private readonly ManualResetEvent ready = new ManualResetEvent(false);
        private readonly ManualResetEvent exited = new ManualResetEvent(false);
        private Process process;
        private NativeJob job;
        private int shutdownRequested, disposed;
        private string localUrl, failureCode;
        private int? exitCode;
        private bool stoppedEvent;
        private long stdoutBytes, stderrBytes;
        public string LocalUrl { get { lock (stateLock) return localUrl; } }
        public string FailureCode { get { lock (stateLock) return failureCode; } }
        public int? ExitCode { get { lock (stateLock) return exitCode; } }
        public bool StoppedEvent { get { lock (stateLock) return stoppedEvent; } }
        public long StdoutBytes { get { return Interlocked.Read(ref stdoutBytes); } }
        public long StderrBytes { get { return Interlocked.Read(ref stderrBytes); } }

        public static bool ValidLocalUrl(string value)
        {
            Uri url;
            return Uri.TryCreate(value, UriKind.Absolute, out url) && url.Scheme == "http"
                && url.Host == "127.0.0.1" && url.Port > 0 && url.Port <= 65535
                && url.AbsolutePath == "/" && url.UserInfo.Length == 0
                && url.Query.Length == 0 && url.Fragment.Length == 0;
        }

        public void Start()
        {
            lock (launchLock)
            {
                if (shutdownRequested != 0) throw new SafeFailure("startup_cancelled");
                string root = AppDomain.CurrentDomain.BaseDirectory;
                string node = Path.Combine(root, "runtime", "node.exe");
                string host = Path.Combine(root, "payload", "tools", "mic-prototype", "desktop", "host.mjs");
                string settings = Path.Combine(root, "launcher.settings.json");
                if (!File.Exists(node)) throw new SafeFailure("bundled_node_missing");
                if (!File.Exists(host)) throw new SafeFailure("bundled_host_missing");
                if (!File.Exists(settings)) throw new SafeFailure("launcher_settings_missing");
                job = new NativeJob();
                Process owned = new Process();
                owned.StartInfo = new ProcessStartInfo(node, Quote(host) + " --settings " + Quote(settings))
                {
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };
                owned.EnableRaisingEvents = true;
                owned.OutputDataReceived += Output;
                owned.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data != null) Interlocked.Add(ref stderrBytes, Encoding.UTF8.GetByteCount(e.Data) + 1);
                };
                owned.Exited += delegate
                {
                    try { lock (stateLock) exitCode = owned.ExitCode; } catch { }
                    exited.Set();
                };
                process = owned;
                try
                {
                    if (!owned.Start()) throw new SafeFailure("node_start_failed");
                    // The host waits for "start": no Codex/Python descendant can precede assignment.
                    job.Assign(owned);
                    owned.BeginOutputReadLine();
                    owned.BeginErrorReadLine();
                    owned.StandardInput.WriteLine(shutdownRequested == 0 ? "{\"command\":\"start\"}" : "{\"command\":\"shutdown\"}");
                    owned.StandardInput.Flush();
                }
                catch
                {
                    try { if (!owned.HasExited) owned.Kill(); } catch { }
                    if (job != null) job.Dispose();
                    throw;
                }
            }
        }

        public bool WaitForReady(int timeoutMs)
        {
            WaitHandle.WaitAny(new WaitHandle[] { ready, exited }, timeoutMs);
            return FailureCode == null && ValidLocalUrl(LocalUrl) && !exited.WaitOne(0);
        }

        private void Output(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            Interlocked.Add(ref stdoutBytes, Encoding.UTF8.GetByteCount(e.Data) + 1);
            if (e.Data.Length > 32768) { Fail("host_protocol_line_too_large"); return; }
            try
            {
                JavaScriptSerializer parser = new JavaScriptSerializer { MaxJsonLength = 32768, RecursionLimit = 16 };
                Dictionary<string, object> value = parser.DeserializeObject(e.Data) as Dictionary<string, object>;
                object eventValue;
                if (value == null || !value.TryGetValue("event", out eventValue) || !(eventValue is string))
                { Fail("host_protocol_invalid"); return; }
                string kind = (string)eventValue;
                if (kind == "ready")
                {
                    object url;
                    if (!value.TryGetValue("localUrl", out url) || !(url is string) || !ValidLocalUrl((string)url))
                    { Fail("host_ready_url_invalid"); return; }
                    lock (stateLock)
                    {
                        if (localUrl != null) { failureCode = "host_duplicate_ready"; }
                        else localUrl = (string)url;
                    }
                    ready.Set();
                }
                else if (kind == "startup_failed")
                {
                    object code;
                    string safeCode = value.TryGetValue("code", out code) ? code as string : null;
                    Fail(safeCode != null && Regex.IsMatch(safeCode, "^[A-Za-z0-9_.:-]{1,160}$") ? safeCode : "host_startup_failed");
                }
                else if (kind == "stopped") { lock (stateLock) stoppedEvent = true; }
                // Ignore future host status events without retaining arbitrary process output.
            }
            catch { Fail("host_protocol_invalid"); }
        }

        private void Fail(string code)
        {
            lock (stateLock) { if (failureCode == null) failureCode = code; }
            ready.Set();
        }

        public bool Stop(int timeoutMs)
        {
            Interlocked.Exchange(ref shutdownRequested, 1);
            Process owned;
            lock (launchLock)
            {
                owned = process;
                if (owned == null) return false;
                try
                {
                    if (!owned.HasExited)
                    {
                        owned.StandardInput.WriteLine("{\"command\":\"shutdown\"}");
                        owned.StandardInput.Flush();
                    }
                }
                catch { /* The private Job Object is the final cleanup fallback. */ }
            }
            bool normal = false;
            try
            {
                if (owned.WaitForExit(timeoutMs))
                {
                    owned.WaitForExit();
                    lock (stateLock) exitCode = owned.ExitCode;
                    normal = owned.ExitCode == 0;
                }
            }
            catch { }
            if (job != null) job.Dispose();
            if (!normal)
            {
                try
                {
                    owned.WaitForExit(3000);
                    if (owned.HasExited) { lock (stateLock) exitCode = owned.ExitCode; }
                }
                catch { }
            }
            return normal;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0) return;
            if (job != null) job.Dispose();
            // Keep the tiny process/event wrappers until process exit: asynchronous pipe callbacks
            // can still arrive during fallback termination. No child handles remain in the job.
        }

        private static string Quote(string value)
        {
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"') result.Append('\\', slashes * 2 + 1).Append('"');
                else result.Append('\\', slashes).Append(character);
                slashes = 0;
            }
            result.Append('\\', slashes * 2).Append('"');
            return result.ToString();
        }
    }

    internal sealed class NativeJob : IDisposable
    {
        private IntPtr handle;
        public NativeJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new SafeFailure("job_create_failed");
            ExtendedLimitInformation limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
            if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
            {
                Dispose();
                throw new SafeFailure("job_configure_failed");
            }
        }

        public void Assign(Process process)
        {
            if (!AssignProcessToJobObject(handle, process.Handle)) throw new SafeFailure("job_assign_failed");
        }

        public void Dispose()
        {
            IntPtr owned = Interlocked.Exchange(ref handle, IntPtr.Zero);
            if (owned != IntPtr.Zero) CloseHandle(owned);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(IntPtr job, int informationClass,
            ref ExtendedLimitInformation information, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
