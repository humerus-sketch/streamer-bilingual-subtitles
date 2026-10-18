using System;
using System.Collections.Generic;
using System.Drawing;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace BilibiliSubtitlePrototype
{
    internal sealed class DesktopWindow : Form
    {
        private BackendSession session;
        private WebView2 view;
        private readonly string smokeResultPath;
        private readonly Label status = new Label();
        private readonly Button reload = new Button();
        private readonly Button exit = new Button();
        private readonly Button software = new Button();
        private readonly Panel content = new Panel();
        private readonly System.Windows.Forms.Timer backendWatch = new System.Windows.Forms.Timer();
        private readonly List<string> pageErrorCodes = new List<string>();
        private readonly List<string> backendFailureCodes = new List<string>();
        private TaskCompletionSource<bool> pageReady;
        private TaskCompletionSource<Dictionary<string, object>> smokeReply;
        private Dictionary<string, object> smokeResult;
        private bool initializing, closing, allowClose, backendReady, pageLoaded;
        private bool settingsOpen, setupPrompted, applyingUpdate;
        private int pageErrorCount, externalNavigationBlocked, permissionDenied;
        private string failureCode;
        public int ResultExitCode { get; private set; }

        public DesktopWindow(string resultPath)
        {
            smokeResultPath = resultPath;
            ResultExitCode = resultPath == null ? 0 : 1;
            Text = "主播双语字幕";
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(1280, 850);
            MinimumSize = new Size(1000, 700);
            StartPosition = FormStartPosition.Manual;
            Location = Screen.PrimaryScreen.WorkingArea.Location;
            // Let Windows apply the monitor working area and actual DPI, including hidden smoke.
            // WebView keeps its natural ZoomFactor; changing zoom would mask a too-small window.
            WindowState = FormWindowState.Maximized;
            Font = new Font("Microsoft YaHei UI", 9F);
            BackColor = Color.FromArgb(246, 247, 243);

            TableLayoutPanel bar = new TableLayoutPanel();
            bar.Dock = DockStyle.Bottom;
            bar.Height = 62;
            bar.Padding = new Padding(14, 9, 14, 9);
            bar.ColumnCount = 4;
            bar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            bar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 160));
            bar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 118));
            bar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 118));
            status.Dock = DockStyle.Fill;
            status.TextAlign = ContentAlignment.MiddleLeft;
            status.Text = "正在启动本地识别与翻译服务……不会自动开启麦克风。";
            reload.Dock = DockStyle.Fill;
            reload.Text = "重新载入";
            reload.Enabled = false;
            reload.Click += async delegate { await ReloadOrRetry(); };
            software.Dock = DockStyle.Fill;
            software.Text = "软件设置与更新";
            software.Click += async delegate { await OpenSoftwareCenter(); };
            exit.Dock = DockStyle.Fill;
            exit.Text = "停止并退出";
            exit.Click += delegate { Close(); };
            bar.Controls.Add(status, 0, 0);
            bar.Controls.Add(software, 1, 0);
            bar.Controls.Add(reload, 2, 0);
            bar.Controls.Add(exit, 3, 0);
            content.Dock = DockStyle.Fill;
            Controls.Add(content);
            Controls.Add(bar);

            backendWatch.Interval = 1000;
            backendWatch.Tick += delegate
            {
                if (!closing && backendReady && session != null && session.ExitCode.HasValue)
                {
                    backendReady = false;
                    backendWatch.Stop();
                    SetFailure("backend_exited");
                }
            };
            Shown += async delegate { await InitializeDesktop(); };
            FormClosing += async delegate(object sender, FormClosingEventArgs e)
            {
                if (allowClose) return;
                e.Cancel = true;
                if (!closing) await ShutdownDesktop();
            };
            if (smokeResultPath != null)
            {
                // Keep a real UI message loop and WebView control, without presenting a window.
                Opacity = 0;
                ShowInTaskbar = false;
            }
        }

        private async Task InitializeDesktop()
        {
            if (initializing || closing) return;
            if (smokeResultPath == null && !setupPrompted && SoftwareCenter.NeedsSetup(AppDomain.CurrentDomain.BaseDirectory))
            {
                setupPrompted = true;
                status.Text = "需要完成首次设置。请选择已有识别环境，或从 GitHub 下载环境与模型。";
                reload.Text = "重试启动"; reload.Enabled = true;
                await OpenSoftwareCenter();
                return;
            }
            initializing = true;
            reload.Enabled = false;
            software.Enabled = false;
            string initializationFailure = null;
            try
            {
                status.Text = "正在启动本地服务并读取 Codex 模型目录……不会自动采音。";
                session = new BackendSession();
                await Task.Factory.StartNew(delegate { session.Start(); });
                bool ready = await Task.Factory.StartNew(delegate { return session.WaitForReady(90000); });
                if (closing) return;
                if (!ready) throw new SafeFailure(session.FailureCode ?? "backend_startup_timeout");
                backendReady = true;
                backendWatch.Start();

                status.Text = "正在初始化内嵌字幕界面……";
                string profile = Path.Combine(SoftwarePaths.SharedRoot, "WebView2");
                Directory.CreateDirectory(profile);
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile, null);
                if (closing) return;
                view = new WebView2();
                view.Dock = DockStyle.Fill;
                content.Controls.Add(view);
                await view.EnsureCoreWebView2Async(environment);
                if (closing) return;
                ConfigureWebView();
                await view.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(LifecycleScript);
                if (closing) return;
                pageReady = new TaskCompletionSource<bool>();
                view.CoreWebView2.Navigate(session.LocalUrl);
                await WithTimeout(pageReady.Task, 30000, "desktop_page_load_timeout");
                if (closing) return;
                status.Text = "桌面界面已就绪。选择模型与麦克风后，点击“开始采音与翻译”。";
                reload.Text = "重新载入";
                reload.Enabled = true;
                if (smokeResultPath != null)
                {
                    smokeReply = new TaskCompletionSource<Dictionary<string, object>>();
                    await view.ExecuteScriptAsync(SmokeScript);
                    smokeResult = await WithTimeout(smokeReply.Task, 90000, "desktop_smoke_script_timeout");
                    if (!ReadBool(smokeResult, "passed"))
                        SetFailure(ReadSafeCode(smokeResult, "failureCode", "desktop_smoke_failed"));
                    await CaptureContentPreview();
                    await ShutdownDesktop();
                }
            }
            catch (SafeFailure error) { initializationFailure = error.Code; }
            catch (WebView2RuntimeNotFoundException) { initializationFailure = "webview2_runtime_missing"; }
            catch (ObjectDisposedException) { if (!closing) initializationFailure = "webview2_disposed_during_startup"; }
            catch { if (!closing) initializationFailure = "desktop_initialization_failed"; }
            finally { initializing = false; if (!closing) software.Enabled = true; }
            if (initializationFailure != null && !closing) await InitializationFailed(initializationFailure);
        }

        private async Task InitializationFailed(string code)
        {
            if (closing) return;
            SetFailure(code);
            reload.Text = "重试启动";
            reload.Enabled = true;
            if (smokeResultPath != null) await ShutdownDesktop();
            else if (code == "desktop_python_missing" || code == "desktop_asr_model_missing"
                || code == "desktop_speaker_assets_missing" || code == "desktop_codex_executable_missing"
                || code == "webview2_runtime_missing" || code == "desktop_invalid_user_settings")
            {
                // A failed startup has no usable service; release its owned Job before setup.
                if (session != null && session.ExitCode.HasValue)
                { session.Dispose(); session = null; }
                await OpenSoftwareCenter();
            }
        }

        private async Task OpenSoftwareCenter()
        {
            if (settingsOpen || closing || initializing || applyingUpdate) return;
            settingsOpen = true;
            try
            {
                using (SoftwareCenter center = new SoftwareCenter(AppDomain.CurrentDomain.BaseDirectory,
                    delegate { return session == null; }, StopBackendForSettings, InstallApplicationUpdate))
                {
                    center.ShowDialog(this);
                    if (center.ConfigurationChanged && !closing && !applyingUpdate)
                    {
                        if (await StopBackendForSettings())
                        {
                            failureCode = null;
                            await InitializeDesktop();
                        }
                        else SetFailure("software_backend_stop_required");
                    }
                }
            }
            finally
            {
                settingsOpen = false;
                if (closing && applyingUpdate && allowClose) Close();
            }
        }

        private async Task<bool> StopBackendForSettings()
        {
            backendWatch.Stop();
            reload.Enabled = false;
            await DisposePage();
            BackendSession owned = session;
            if (owned == null) { backendReady = false; return true; }
            bool graceful = session == null;
            try
            {
                graceful = await Task.Factory.StartNew(delegate
                {
                    bool stopped = owned.Stop(90000);
                    // ExitCode alone cannot prove gateway queues and sessions drained normally.
                    return stopped && owned.StoppedEvent && owned.ExitCode == 0;
                });
            }
            finally { owned.Dispose(); session = null; backendReady = false; }
            status.Text = graceful ? "字幕服务已正常停止。" : "字幕服务未能正常停止，已取消安装。";
            if (!closing) { reload.Text = "重试启动"; reload.Enabled = true; }
            return graceful;
        }

        private async Task<bool> InstallApplicationUpdate(string planPath)
        {
            if (closing || initializing || applyingUpdate) return false;
            applyingUpdate = true;
            try
            {
                if (!await StopBackendForSettings()) return false;
                string helper = await Task.Factory.StartNew(delegate
                    { return SoftwareInstall.StageUpdateHelper(AppDomain.CurrentDomain.BaseDirectory, planPath); });
                ProcessStartInfo info = new ProcessStartInfo(helper, "--apply-update " + QuoteArgument(planPath)
                    + " --wait-pid " + Process.GetCurrentProcess().Id)
                { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(helper) };
                if (Process.Start(info) == null) throw new SafeFailure("software_update_start_failed");
                // The helper waits for this GUI to exit; it cannot replace files while they are loaded.
                closing = true; allowClose = true;
                return true;
            }
            catch (SafeFailure) { throw; }
            catch { throw new SafeFailure("software_update_start_failed"); }
            finally { if (!closing) applyingUpdate = false; }
        }

        private static string QuoteArgument(string value)
        {
            StringBuilder result = new StringBuilder("\""); int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"') result.Append('\\', slashes * 2 + 1).Append('"');
                else result.Append('\\', slashes).Append(character);
                slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }

        private void ConfigureWebView()
        {
            CoreWebView2 core = view.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsWebMessageEnabled = true;
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                if (!AllowedPage(e.Uri))
                {
                    e.Cancel = true;
                    externalNavigationBlocked++;
                    if (!closing) status.Text = "已阻止离开本次本地字幕界面；不会打开外部浏览器。";
                }
            };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                externalNavigationBlocked++;
                if (!closing) status.Text = "已阻止弹出外部页面。";
            };
            core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e)
            {
                e.State = CoreWebView2PermissionState.Deny;
                e.Handled = true;
                permissionDenied++;
            };
            core.WebMessageReceived += PageMessage;
            core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e)
            {
                if (closing || pageReady == null) return;
                if (e.IsSuccess && AllowedPage(core.Source))
                {
                    pageLoaded = true;
                    pageReady.TrySetResult(true);
                }
                else pageReady.TrySetException(new SafeFailure("desktop_page_navigation_failed"));
            };
            core.ProcessFailed += delegate
            {
                if (closing) return;
                SetFailure("webview2_process_failed");
                if (pageReady != null) pageReady.TrySetException(new SafeFailure("webview2_process_failed"));
                if (smokeReply != null) smokeReply.TrySetException(new SafeFailure("webview2_process_failed"));
            };
        }

        private bool AllowedPage(string value)
        {
            if (session == null || !BackendSession.ValidLocalUrl(session.LocalUrl)) return false;
            Uri candidate, origin = new Uri(session.LocalUrl);
            return Uri.TryCreate(value, UriKind.Absolute, out candidate)
                && candidate.Scheme == origin.Scheme && candidate.Host == origin.Host
                && candidate.Port == origin.Port && candidate.UserInfo.Length == 0
                && candidate.AbsolutePath == "/" && candidate.Query.Length == 0;
        }

        private void PageMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (closing || !AllowedPage(e.Source)) return;
            try
            {
                string json = e.WebMessageAsJson;
                if (json.Length > 4096) return;
                JavaScriptSerializer parser = new JavaScriptSerializer { MaxJsonLength = 4096, RecursionLimit = 10 };
                Dictionary<string, object> value = parser.DeserializeObject(json) as Dictionary<string, object>;
                if (value == null) return;
                object type;
                if (!value.TryGetValue("type", out type) || !(type is string)) return;
                if ((string)type == "desktop_page_error")
                {
                    string code = ReadSafeCode(value, "code", "page_unhandled_error");
                    pageErrorCount++;
                    if (pageErrorCodes.Count < 32) pageErrorCodes.Add(code);
                    RecordCode("page", code);
                    status.Text = "界面出现异常：" + code + "。可重新载入；当前采音状态请以页面为准。";
                }
                else if ((string)type == "desktop_smoke_result" && smokeResultPath != null && smokeReply != null)
                {
                    // Project fixed fields only: never persist HTML, capabilities, device names or utterances.
                    Dictionary<string, object> projected = new Dictionary<string, object>();
                    foreach (string key in new string[] { "passed", "documentReady", "modelSwitchVerified", "modelRestored", "idleBefore", "idleAfter", "controlLayoutVerified", "modelControlsWithinViewport", "deviceControlsWithinViewport", "startControlWithinViewport" })
                        projected[key] = ReadBool(value, key);
                    foreach (string key in new string[] { "modelCount", "revisionBefore", "revisionAfter", "deviceCount", "wasapiInputCount", "pageErrors", "viewportCssWidth", "viewportCssHeight" })
                        projected[key] = ReadInt(value, key);
                    projected["devicePixelRatio"] = ReadNumber(value, "devicePixelRatio");
                    projected["failureCode"] = ReadSafeCode(value, "failureCode", null);
                    smokeReply.TrySetResult(projected);
                }
            }
            catch { /* Arbitrary page payloads are neither surfaced nor retained. */ }
        }

        private async Task ReloadOrRetry()
        {
            if (closing || initializing) return;
            if (!backendReady || view == null || view.IsDisposed || view.CoreWebView2 == null)
            {
                reload.Enabled = false;
                await DisposePage();
                if (session != null)
                {
                    BackendSession old = session;
                    await Task.Factory.StartNew(delegate { old.Stop(90000); old.Dispose(); });
                }
                backendReady = false;
                failureCode = null;
                await InitializeDesktop();
                return;
            }
            try
            {
                reload.Enabled = false;
                status.Text = "正在重新载入界面；后端任务继续按原状态运行。";
                await WithTimeout(view.ExecuteScriptAsync("if(window.__subtitleDesktop)window.__subtitleDesktop.stop();"), 2000, "page_cleanup_timeout");
                pageReady = new TaskCompletionSource<bool>();
                view.CoreWebView2.Navigate(session.LocalUrl);
                await WithTimeout(pageReady.Task, 30000, "desktop_page_load_timeout");
                if (!closing) status.Text = "界面已重新载入。";
            }
            catch { if (!closing) SetFailure("desktop_page_reload_failed"); }
            finally { if (!closing) reload.Enabled = true; }
        }

        private void SetFailure(string code)
        {
            if (!Regex.IsMatch(code ?? "", "^[A-Za-z0-9_.:-]{1,160}$")) code = "desktop_failed";
            if (failureCode == null) failureCode = code;
            if (backendFailureCodes.Count < 32) backendFailureCodes.Add(code);
            RecordCode("desktop", code);
            status.Text = "桌面客户端未完成：" + code + "。可重试，或停止并退出。";
            reload.Text = backendReady ? "重新载入" : "重试启动";
            reload.Enabled = true;
        }

        private async Task CaptureContentPreview()
        {
            if (smokeResultPath == null || view == null || view.CoreWebView2 == null) return;
            try
            {
                string directory = Path.GetDirectoryName(Path.GetFullPath(smokeResultPath));
                Directory.CreateDirectory(directory);
                string name = Path.GetFileNameWithoutExtension(smokeResultPath) + ".content.png";
                using (FileStream file = new FileStream(Path.Combine(directory, name), FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                    await WithTimeout(view.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file), 10000, "desktop_preview_timeout");
                if (smokeResult != null) smokeResult["contentPreviewFile"] = name;
            }
            catch
            {
                if (smokeResult != null) smokeResult["previewFailureCode"] = "desktop_preview_failed";
            }
        }

        private static void RecordCode(string kind, string code)
        {
            try
            {
                string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BilibiliSubtitlePrototype");
                Directory.CreateDirectory(directory);
                string path = Path.Combine(directory, "desktop-events.jsonl");
                if (File.Exists(path) && new FileInfo(path).Length >= 1048576) return;
                Dictionary<string, object> entry = new Dictionary<string, object>();
                entry["at"] = DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(8)).ToString("yyyy-MM-dd'T'HH:mm:sszzz");
                entry["kind"] = kind;
                entry["code"] = code;
                File.AppendAllText(path, new JavaScriptSerializer().Serialize(entry) + Environment.NewLine, new UTF8Encoding(false));
            }
            catch { /* Diagnostics must not make a failed page or startup less recoverable. */ }
        }

        private async Task DisposePage()
        {
            WebView2 owned = view;
            view = null;
            if (owned == null || owned.IsDisposed) return;
            try
            {
                if (owned.CoreWebView2 != null)
                {
                    await WithTimeout(owned.ExecuteScriptAsync("if(window.__subtitleDesktop)window.__subtitleDesktop.stop();"), 2000, "page_cleanup_timeout");
                    owned.CoreWebView2.Stop();
                }
            }
            catch { /* Disposing the control also closes page connections when its renderer failed. */ }
            content.Controls.Remove(owned);
            owned.Dispose();
        }

        private async Task ShutdownDesktop()
        {
            if (closing) return;
            closing = true;
            backendWatch.Stop();
            reload.Enabled = false;
            software.Enabled = false;
            exit.Enabled = false;
            status.Text = "正在停止界面连接与本次后台任务……最多等待 90 秒。";
            bool graceful = session == null;
            try
            {
                // Stop SSE and page timers before disposing WebView, then drain the local server.
                await DisposePage();
                BackendSession owned = session;
                if (owned != null)
                    graceful = await Task.Factory.StartNew(delegate { bool ok = owned.Stop(90000); owned.Dispose(); return ok; });
            }
            catch { if (session != null) session.Dispose(); }
            if (!graceful && failureCode == null) failureCode = "desktop_graceful_shutdown_failed";
            if (smokeResultPath != null) WriteSmokeResult(graceful);
            allowClose = true;
            Close();
        }

        private void WriteSmokeResult(bool graceful)
        {
            Dictionary<string, object> result = smokeResult ?? new Dictionary<string, object>();
            bool passed = ReadBool(result, "passed") && graceful && failureCode == null && pageErrorCount == 0;
            result["passed"] = passed;
            result["embedded"] = true;
            result["browserOpened"] = false;
            result["microphoneStarted"] = false;
            result["translationSubmitted"] = false;
            result["pageLoaded"] = pageLoaded;
            result["nativePageErrorCount"] = pageErrorCount;
            result["pageErrorCodes"] = pageErrorCodes;
            result["backendFailureCodes"] = backendFailureCodes;
            result["externalNavigationBlocked"] = externalNavigationBlocked;
            result["permissionRequestsDenied"] = permissionDenied;
            result["gracefulExit"] = graceful;
            result["backendExitCode"] = session == null ? null : session.ExitCode;
            result["backendStoppedEvent"] = session != null && session.StoppedEvent;
            result["stdoutBytes"] = session == null ? 0 : session.StdoutBytes;
            result["stderrBytes"] = session == null ? 0 : session.StderrBytes;
            result["failureCode"] = failureCode ?? ReadSafeCode(result, "failureCode", null);
            result["scope"] = "embedded_ui_model_switch_device_inventory_and_shutdown_only";
            try
            {
                string path = Path.GetFullPath(smokeResultPath);
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                using (FileStream file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                using (StreamWriter writer = new StreamWriter(file, new UTF8Encoding(false)))
                    writer.WriteLine(new JavaScriptSerializer().Serialize(result));
                ResultExitCode = passed ? 0 : 1;
            }
            catch { ResultExitCode = 1; }
        }

        private static bool ReadBool(Dictionary<string, object> value, string key)
        {
            object item;
            return value.TryGetValue(key, out item) && item is bool && (bool)item;
        }
        private static int ReadInt(Dictionary<string, object> value, string key)
        {
            object item;
            if (!value.TryGetValue(key, out item)) return -1;
            if (item is int) return (int)item;
            return -1;
        }
        private static double ReadNumber(Dictionary<string, object> value, string key)
        {
            object item;
            if (!value.TryGetValue(key, out item) || !(item is int || item is long || item is double || item is decimal)) return -1;
            double number = Convert.ToDouble(item);
            return double.IsNaN(number) || double.IsInfinity(number) ? -1 : number;
        }
        private static string ReadSafeCode(Dictionary<string, object> value, string key, string fallback)
        {
            object item;
            string text = value.TryGetValue(key, out item) ? item as string : null;
            return text != null && Regex.IsMatch(text, "^[A-Za-z0-9_.:-]{1,160}$") ? text : fallback;
        }
        private static async Task<T> WithTimeout<T>(Task<T> task, int timeoutMs, string code)
        {
            if (await Task.WhenAny(task, Task.Delay(timeoutMs)) != task) throw new SafeFailure(code);
            return await task;
        }
        private static async Task WithTimeout(Task task, int timeoutMs, string code)
        {
            if (await Task.WhenAny(task, Task.Delay(timeoutMs)) != task) throw new SafeFailure(code);
            await task;
        }

        private const string LifecycleScript = @"
(function(){
  'use strict';
  const sources=new Set(), intervals=new Set(), timeouts=new Set();
  const rawInterval=window.setInterval.bind(window), rawClearInterval=window.clearInterval.bind(window);
  const rawTimeout=window.setTimeout.bind(window), rawClearTimeout=window.clearTimeout.bind(window);
  const rawEventSource=window.EventSource;
  const desktop={pageErrors:0,stopped:false};
  function error(code){desktop.pageErrors++;window.chrome.webview.postMessage({type:'desktop_page_error',code});}
  window.addEventListener('error',()=>error('page_unhandled_error'));
  window.addEventListener('unhandledrejection',()=>error('page_unhandled_rejection'));
  window.EventSource=class extends rawEventSource{constructor(...args){super(...args);sources.add(this);}};
  window.setInterval=function(...args){const id=rawInterval(...args);intervals.add(id);return id;};
  window.clearInterval=function(id){intervals.delete(id);rawClearInterval(id);};
  window.setTimeout=function(handler,delay,...args){let id;const callback=typeof handler==='function'?function(...values){timeouts.delete(id);handler(...values);}:handler;id=rawTimeout(callback,delay,...args);timeouts.add(id);return id;};
  window.clearTimeout=function(id){timeouts.delete(id);rawClearTimeout(id);};
  desktop.stop=function(){if(desktop.stopped)return;desktop.stopped=true;for(const source of sources)source.close();sources.clear();for(const id of intervals)rawClearInterval(id);intervals.clear();for(const id of timeouts)rawClearTimeout(id);timeouts.clear();};
  window.__subtitleDesktop=desktop;
})();";

        private const string SmokeScript = @"
(async function(){
  'use strict';
  const result={type:'desktop_smoke_result',passed:false,documentReady:false,modelSwitchVerified:false,modelRestored:false,idleBefore:false,idleAfter:false,modelCount:0,revisionBefore:-1,revisionAfter:-1,deviceCount:-1,wasapiInputCount:-1,pageErrors:0,viewportCssWidth:0,viewportCssHeight:0,devicePixelRatio:0,controlLayoutVerified:false,modelControlsWithinViewport:false,deviceControlsWithinViewport:false,startControlWithinViewport:false,failureCode:null};
  const delay=ms=>new Promise(done=>setTimeout(done,ms));
  const check=(condition,code)=>{if(!condition)throw new Error(code);};
  const idle=value=>!value.workerActive&&!value.captureStarting&&!value.session&&!(value.queue?.active>0)&&!(value.queue?.pending>0);
  const getState=async()=>{const response=await fetch('/state');check(response.ok,'smoke_state_http_failed');return response.json();};
  async function until(action,code){const end=Date.now()+20000;while(Date.now()<end){const value=await action();if(value)return value;await delay(50);}throw new Error(code);}
  try{
    check(document.readyState==='complete'&&document.querySelector('#model')&&document.querySelector('#devices'),'smoke_document_not_ready');
    result.documentReady=true;
    await until(()=>typeof state!=='undefined'&&Array.isArray(state.models)&&state.models.length>=2&&document.querySelector('#model').options.length>=3,'smoke_model_directory_not_ready');
    const before=await getState();
    result.modelCount=before.models.length;
    result.idleBefore=idle(before);check(result.idleBefore,'smoke_backend_not_idle');
    let inventoryFingerprint='',stableInventory=0;
    await until(()=>{const button=document.querySelector('#devices'),device=document.querySelector('#device');const fingerprint=String(device?.options.length||0)+'/'+String(button?.disabled);stableInventory=fingerprint===inventoryFingerprint?stableInventory+1:0;inventoryFingerprint=fingerprint;return button&&!button.disabled&&device&&stableInventory>=5;},'smoke_device_controls_not_stable');
    const selector=document.querySelector('#model'), original=before.selectedModel;
    const target=before.models.find(model=>model.slug!==original);
    check(target&&!selector.disabled,'smoke_model_switch_unavailable');
    result.revisionBefore=before.modelSelectionRevision;
    selector.value=target.slug;selector.dispatchEvent(new Event('change',{bubbles:true}));
    const changed=await until(async()=>{const current=await getState();return current.selectedModel===target.slug&&current.modelSelectionRevision>result.revisionBefore&&selector.value===target.slug&&modelSelection.snapshot().pending===null?current:null;},'smoke_model_switch_not_confirmed');
    result.revisionAfter=changed.modelSelectionRevision;
    result.modelSwitchVerified=true;
    if(before.models.some(model=>model.slug===original)){
      selector.value=original;selector.dispatchEvent(new Event('change',{bubbles:true}));
      await until(async()=>{const current=await getState();return current.selectedModel===original&&current.modelSelectionRevision>result.revisionAfter&&modelSelection.snapshot().pending===null;},'smoke_model_restore_not_confirmed');
      result.modelRestored=true;
    }
    const inventory=await post('/devices');
    check(Array.isArray(inventory.devices),'smoke_device_inventory_invalid');
    result.deviceCount=inventory.devices.length;
    result.wasapiInputCount=inventory.devices.filter(device=>device.isWasapi&&device.maxInputChannels>0).length;
    await delay(150);
    result.idleAfter=idle(await getState());check(result.idleAfter,'smoke_audio_or_translation_unexpected');
    window.scrollTo(0,0);
    await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
    result.viewportCssWidth=window.innerWidth;result.viewportCssHeight=window.innerHeight;result.devicePixelRatio=window.devicePixelRatio;
    check(result.viewportCssWidth>=1000,'smoke_viewport_too_narrow');
    const visible=id=>{const node=document.getElementById(id);if(!node)return false;const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1;};
    result.modelControlsWithinViewport=visible('model');
    result.deviceControlsWithinViewport=visible('device')&&visible('devices');
    result.startControlWithinViewport=visible('start');
    result.controlLayoutVerified=result.modelControlsWithinViewport&&result.deviceControlsWithinViewport&&result.startControlWithinViewport;
    check(result.controlLayoutVerified,'smoke_primary_controls_outside_viewport');
    result.pageErrors=window.__subtitleDesktop.pageErrors;check(result.pageErrors===0,'smoke_page_errors_present');
    result.passed=true;
  }catch(error){const code=String(error?.message||'');result.failureCode=/^[A-Za-z0-9_.:-]{1,160}$/.test(code)?code:'desktop_smoke_failed';result.pageErrors=window.__subtitleDesktop?.pageErrors||0;}
  window.chrome.webview.postMessage(result);
})();";
    }
}
