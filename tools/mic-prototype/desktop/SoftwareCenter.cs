using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace BilibiliSubtitlePrototype
{
    // This form remains available when Python, models, Codex or WebView cannot start.
    internal sealed class SoftwareCenter : Form
    {
        private readonly string packageRoot;
        private readonly Func<bool> backendStopped;
        private readonly Func<Task<bool>> stopBackend;
        private readonly Func<string, Task<bool>> installAppUpdate;
        private readonly Dictionary<string, TextBox> fields = new Dictionary<string, TextBox>();
        private readonly List<Button> actions = new List<Button>();
        private readonly Label status = new Label();
        private readonly Label release = new Label();
        private readonly Label dataPath = new Label();
        private readonly ProgressBar progress = new ProgressBar();
        private readonly Button update = new Button();
        private readonly Button cancelDownload = new Button();
        private readonly Button done = new Button();
        private Dictionary<string, object> settings;
        private bool busy, updateAvailable;
        private Process downloadProcess;
        private bool downloadCancelRequested;
        public bool ConfigurationChanged { get; private set; }

        public SoftwareCenter(string root, Func<bool> isStopped, Func<Task<bool>> stop,
            Func<string, Task<bool>> installUpdate)
        {
            packageRoot = Path.GetFullPath(root);
            backendStopped = isStopped;
            stopBackend = stop;
            installAppUpdate = installUpdate;
            Text = "主播双语字幕 · 软件设置与更新";
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(900, 700);
            MinimumSize = new Size(840, 690);
            Font = new Font("Microsoft YaHei UI", 9F);
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;

            TableLayoutPanel layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.Padding = new Padding(20);
            layout.ColumnCount = 3;
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 122));
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
            layout.RowCount = 12;
            for (int i = 0; i < 12; i++) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, i == 0 ? 62 : i == 9 ? 76 : 36));
            layout.RowStyles[6] = new RowStyle(SizeType.Absolute, 60);
            layout.RowStyles[7] = new RowStyle(SizeType.Absolute, 40);
            layout.RowStyles[8] = new RowStyle(SizeType.Absolute, 40);
            layout.RowStyles[10] = new RowStyle(SizeType.Percent, 100);
            release.Dock = DockStyle.Fill;
            release.Text = "读取软件版本……";
            layout.Controls.Add(release, 0, 0); layout.SetColumnSpan(release, 3);
            AddPath(layout, 1, "pythonExecutable", "Python 程序", false);
            AddPath(layout, 2, "modelDirectory", "Whisper 模型", true);
            AddPath(layout, 3, "speakerAssets", "声纹模型", true);
            AddPath(layout, 4, "codexExecutable", "Codex 程序", false);
            Label data = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Text = "本机数据" };
            dataPath.Dock = DockStyle.Fill; dataPath.TextAlign = ContentAlignment.MiddleLeft;
            dataPath.AutoEllipsis = true; dataPath.Text = Path.Combine(SoftwarePaths.SharedRoot, "data");
            layout.Controls.Add(data, 0, 5); layout.Controls.Add(dataPath, 1, 5); layout.SetColumnSpan(dataPath, 2);
            Label note = new Label { Dock = DockStyle.Fill, Text = "Codex 留空时自动沿用已有官方客户端；新电脑使用随环境下载的官方 CLI。模型、声纹、设置和登录不会随软件更新删除。\r\n首次下载约 4 GiB，建议预留至少 12 GiB 可用磁盘空间。" };
            layout.Controls.Add(note, 0, 6); layout.SetColumnSpan(note, 3);

            FlowLayoutPanel environment = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
            environment.Controls.Add(Action("下载并安装识别环境", async delegate { await DownloadComponents(); }, 190));
            environment.Controls.Add(Action("保存设置", delegate { SaveSettings(); return Task.FromResult(true); }, 105));
            environment.Controls.Add(Action("Codex 登录", delegate { OpenCodexLogin(); return Task.FromResult(true); }, 112));
            environment.Controls.Add(Action("WebView2 运行库", delegate { OpenWebViewHelp(); return Task.FromResult(true); }, 130));
            layout.Controls.Add(environment, 0, 7); layout.SetColumnSpan(environment, 3);
            FlowLayoutPanel updates = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
            updates.Controls.Add(Action("检查 GitHub 更新", async delegate { await CheckUpdate(); }, 160));
            update.Text = "下载并安装更新"; update.Width = 150; update.Height = 30; update.Enabled = false;
            update.Click += async delegate { await RunAction(DownloadApplication); };
            updates.Controls.Add(update); actions.Add(update);
            cancelDownload.Text = "取消下载"; cancelDownload.Width = 112; cancelDownload.Height = 30;
            cancelDownload.Enabled = false;
            cancelDownload.Click += async delegate { await CancelDownload(); };
            updates.Controls.Add(cancelDownload);
            layout.Controls.Add(updates, 0, 8); layout.SetColumnSpan(updates, 3);
            status.Dock = DockStyle.Fill;
            status.Text = "仅在点击开始后才会采音；此设置窗口不会开启麦克风或提交翻译。";
            layout.Controls.Add(status, 0, 9); layout.SetColumnSpan(status, 3);
            progress.Dock = DockStyle.Top; progress.Height = 18; progress.Style = ProgressBarStyle.Continuous;
            layout.Controls.Add(progress, 0, 10); layout.SetColumnSpan(progress, 3);
            done.Text = "返回字幕软件"; done.Dock = DockStyle.Right; done.Width = 150;
            done.Click += delegate { Close(); };
            layout.Controls.Add(done, 0, 11); layout.SetColumnSpan(done, 3);
            Controls.Add(layout);
            FormClosing += delegate(object sender, FormClosingEventArgs args) { if (busy) args.Cancel = true; };
            Shown += delegate { LoadSettings(); };
        }

        private Button Action(string text, Func<Task> action, int width)
        {
            Button button = new Button { Text = text, Width = width, Height = 30 };
            button.Click += async delegate { await RunAction(action); };
            actions.Add(button);
            return button;
        }

        private void AddPath(TableLayoutPanel layout, int row, string key, string title, bool directory)
        {
            Label label = new Label { Text = title, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft };
            TextBox text = new TextBox { Dock = DockStyle.Fill };
            fields.Add(key, text);
            Button choose = new Button { Text = "选择…", Dock = DockStyle.Fill };
            choose.Click += delegate
            {
                if (directory)
                {
                    using (FolderBrowserDialog picker = new FolderBrowserDialog())
                    {
                        picker.Description = "选择" + title + "目录";
                        if (Directory.Exists(text.Text)) picker.SelectedPath = text.Text;
                        if (picker.ShowDialog(this) == DialogResult.OK) text.Text = picker.SelectedPath;
                    }
                }
                else using (OpenFileDialog picker = new OpenFileDialog())
                {
                    picker.Title = "选择" + title;
                    picker.Filter = "可执行程序 (*.exe)|*.exe";
                    picker.CheckFileExists = true;
                    if (picker.ShowDialog(this) == DialogResult.OK) text.Text = picker.FileName;
                }
            };
            actions.Add(choose);
            layout.Controls.Add(label, 0, row); layout.Controls.Add(text, 1, row); layout.Controls.Add(choose, 2, row);
        }

        public static bool NeedsSetup(string root)
        {
            try { return Missing(ReadSettings(root)).Length > 0; }
            catch { return true; }
        }

        private void LoadSettings()
        {
            try
            {
                settings = ReadSettings(packageRoot);
                foreach (KeyValuePair<string, TextBox> field in fields) field.Value.Text = StringValue(settings, field.Key);
                dataPath.Text = StringValue(settings, "dataDirectory");
                string missing = Missing(settings);
                status.Text = missing.Length == 0
                    ? "识别环境已找到。保存路径后返回即可重启字幕服务；Codex 登录沿用官方客户端。"
                    : "首次设置：缺少" + missing + "。可选择已有环境，或点击下载并安装识别环境。";
            }
            catch
            {
                settings = DefaultSettings();
                foreach (KeyValuePair<string, TextBox> field in fields) field.Value.Text = StringValue(settings, field.Key);
                dataPath.Text = StringValue(settings, "dataDirectory");
                status.Text = "当前配置无法读取。请选择本机环境并保存；原有数据和登录不会被删除。";
            }
            try
            {
                Dictionary<string, object> info = ReadJson(Path.Combine(packageRoot, "software-release.json"));
                release.Text = "主播双语字幕  " + StringValue(info, "version") + "\r\nGitHub：" + StringValue(info, "repository")
                    + "    ·    稳定版更新";
            }
            catch { release.Text = "主播双语字幕\r\n软件版本信息缺失；可继续配置本机识别环境。"; }
        }

        private async Task RunAction(Func<Task> action)
        {
            if (busy) return;
            SetBusy(true);
            try { await action(); }
            catch (SafeFailure error) { status.Text = Friendly(error.Code); }
            catch { status.Text = "操作未完成，请检查网络和本机目录权限后重试；现有环境保持原状。"; }
            finally { SetBusy(false); }
        }

        private void SetBusy(bool value)
        {
            busy = value;
            foreach (Button button in actions) button.Enabled = !value;
            update.Enabled = !value && updateAvailable;
            foreach (TextBox field in fields.Values) field.ReadOnly = value;
            done.Enabled = !value;
            if (!value) cancelDownload.Enabled = false;
            progress.Style = value ? ProgressBarStyle.Marquee : ProgressBarStyle.Continuous;
            if (!value) progress.Value = 0;
        }

        private async Task CheckUpdate()
        {
            status.Text = "正在检查 GitHub 稳定版更新……";
            Dictionary<string, object> result = await RunCli("check");
            object available;
            updateAvailable = result.TryGetValue("updateAvailable", out available) && available is bool && (bool)available;
            status.Text = updateAvailable ? "发现新版本 " + StringValue(result, "latestVersion") + "，可下载并安装。"
                : "当前版本 " + StringValue(result, "currentVersion") + " 已是最新稳定版。";
        }

        private async Task DownloadApplication()
        {
            status.Text = "正在下载并校验新版本，字幕服务可继续运行……";
            Dictionary<string, object> result = await RunCli("download-app");
            string planPath = StringValue(result, "planPath");
            if (planPath.Length == 0) throw new SafeFailure("software_update_plan_missing");
            status.Text = "新版本已校验。正在正常停止字幕服务后安装……";
            bool applied = await installAppUpdate(planPath);
            if (!applied) status.Text = "未安装更新：字幕服务未能正常停止。已取消安装，可稍后重试。";
            else
            {
                // Release this modal first; its busy close guard must not block the owner's exit.
                SetBusy(false);
                DialogResult = DialogResult.OK;
                Close();
            }
        }

        private async Task DownloadComponents()
        {
            status.Text = "正在下载并校验识别环境和模型，首次下载可能需要较长时间……";
            Dictionary<string, object> result = await RunCli("download-components");
            string planPath = StringValue(result, "planPath");
            if (planPath.Length == 0) throw new SafeFailure("software_update_plan_missing");
            if (!backendStopped())
            {
                status.Text = "环境已校验。正在正常停止字幕服务后安装……";
                if (!await stopBackend() || !backendStopped())
                    throw new SafeFailure("software_backend_stop_required");
            }
            await Task.Factory.StartNew(delegate { SoftwareInstall.InstallComponents(planPath); });
            ConfigurationChanged = true;
            // Existing explicit paths stay selected; missing paths may use the newly installed defaults.
            if (!File.Exists(fields["pythonExecutable"].Text)) fields["pythonExecutable"].Text = Path.Combine(SoftwarePaths.SharedRoot, "runtime", "python", "python.exe");
            if (!File.Exists(Path.Combine(fields["modelDirectory"].Text, "model.bin"))) fields["modelDirectory"].Text = Path.Combine(SoftwarePaths.SharedRoot, "models", "large-v3");
            if (!File.Exists(Path.Combine(fields["speakerAssets"].Text, "manifest.json"))) fields["speakerAssets"].Text = Path.Combine(SoftwarePaths.SharedRoot, "models", "speaker");
            if (!SaveSettings()) return;
            status.Text = "识别环境已下载、校验并安装。返回字幕软件后启动；现有模型、声纹和登录均保留。";
        }

        private async Task<Dictionary<string, object>> RunCli(string command)
        {
            string node = Path.Combine(packageRoot, "runtime", "node.exe");
            string cli = Path.Combine(packageRoot, "payload", "tools", "mic-prototype", "software", "update-cli.mjs");
            if (!File.Exists(node) || !File.Exists(cli)) throw new SafeFailure("software_update_runtime_missing");
            Dictionary<string, object> complete = null;
            string failure = null;
            object gate = new object();
            using (Process owned = new Process())
            {
                bool canCancel = command == "download-app" || command == "download-components";
                downloadCancelRequested = false;
                owned.StartInfo = new ProcessStartInfo(node, Quote(cli) + " --package-root " + Quote(packageRoot)
                    + " --data-root " + Quote(SoftwarePaths.SharedRoot) + " --command " + command)
                {
                    WorkingDirectory = packageRoot, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                };
                owned.OutputDataReceived += delegate(object sender, DataReceivedEventArgs entry)
                {
                    if (entry.Data == null) return;
                    try
                    {
                        if (entry.Data.Length > 65536) throw new SafeFailure("software_update_protocol_invalid");
                        Dictionary<string, object> item = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 20 }
                            .DeserializeObject(entry.Data) as Dictionary<string, object>;
                        if (item == null) throw new SafeFailure("software_update_protocol_invalid");
                        string kind = StringValue(item, "event");
                        if (kind == "complete") { lock (gate) complete = item; }
                        else if (kind == "error" || kind == "failed") { lock (gate) failure = SafeCode(StringValue(item, "code")); }
                        else if (kind == "progress")
                        {
                            string stage = StringValue(item, "stage");
                            if (stage.Length == 0) stage = StringValue(item, "phase");
                            OnUi(delegate
                            {
                                if (!busy || downloadCancelRequested) return;
                                status.Text = ProgressText(stage);
                                object total, received;
                                if (item.TryGetValue("totalBytes", out total) &&
                                    (item.TryGetValue("downloadedBytes", out received) || item.TryGetValue("bytes", out received)))
                                {
                                    long max, current;
                                    if (long.TryParse(Convert.ToString(total, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out max)
                                        && long.TryParse(Convert.ToString(received, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out current) && max > 0)
                                    { progress.Style = ProgressBarStyle.Continuous; progress.Value = (int)Math.Max(0, Math.Min(100, (double)current / max * 100)); }
                                }
                            });
                        }
                    }
                    catch { lock (gate) failure = "software_update_protocol_invalid"; }
                };
                owned.ErrorDataReceived += delegate { /* Never forward arbitrary child stderr or credentials to UI or logs. */ };
                if (!owned.Start()) throw new SafeFailure("software_update_start_failed");
                if (canCancel) { downloadProcess = owned; cancelDownload.Enabled = true; }
                try
                {
                    owned.BeginOutputReadLine(); owned.BeginErrorReadLine();
                    await Task.Factory.StartNew(delegate { owned.WaitForExit(); owned.WaitForExit(); });
                    lock (gate)
                    {
                        // Cancellation wins even if a terminal line raced with the button click.
                        if (canCancel && downloadCancelRequested) throw new SafeFailure("software_download_cancelled");
                        if (failure != null) throw new SafeFailure(failure);
                        if (owned.ExitCode != 0 || complete == null) throw new SafeFailure("software_update_failed");
                        return complete;
                    }
                }
                finally { if (canCancel) { downloadProcess = null; cancelDownload.Enabled = false; } }
            }
        }

        private async Task CancelDownload()
        {
            Process owned = downloadProcess;
            if (owned == null || !cancelDownload.Enabled) return;
            downloadCancelRequested = true;
            cancelDownload.Enabled = false;
            status.Text = "正在取消本次下载，等待下载进程退出……不会开始安装。";
            try
            {
                // Only the Process instance created by this form is terminated; no process-name sweep.
                if (!owned.HasExited) owned.Kill();
                await Task.Factory.StartNew(delegate { owned.WaitForExit(); });
            }
            catch (InvalidOperationException) { /* RunCli may already have observed and disposed this exited child. */ }
            catch
            {
                status.Text = "取消请求已记录，但下载进程尚未退出。可再次取消；本次下载不会安装。";
                if (downloadProcess == owned) cancelDownload.Enabled = true;
            }
        }

        private bool SaveSettings()
        {
            Dictionary<string, object> selected = new Dictionary<string, object>();
            selected["schemaVersion"] = 1;
            foreach (string key in new string[] { "dataDirectory", "codexModel", "codexServiceTier" })
                if (settings.ContainsKey(key)) selected[key] = settings[key];
            foreach (KeyValuePair<string, TextBox> field in fields)
            {
                string value = field.Value.Text.Trim();
                if (value.Length == 0 && field.Key == "codexExecutable") { selected[field.Key] = ""; continue; }
                if (!Path.IsPathRooted(value) || value.IndexOfAny(new char[] { '\r', '\n', '\0' }) >= 0)
                    throw new SafeFailure("software_settings_path_invalid");
                selected[field.Key] = Path.GetFullPath(value);
            }
            string missing = Missing(selected);
            if (missing.Length > 0) { status.Text = "尚未保存：缺少" + missing + "。请选择有效目录，或先下载识别环境。"; return false; }
            string codex = StringValue(selected, "codexExecutable");
            if (codex.Length > 0 && (!File.Exists(codex) || !codex.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)))
                throw new SafeFailure("desktop_codex_executable_missing");
            Directory.CreateDirectory(SoftwarePaths.SharedRoot);
            string destination = Path.Combine(SoftwarePaths.SharedRoot, "desktop.settings.json");
            string pending = destination + ".pending-" + Guid.NewGuid().ToString("N");
            File.WriteAllText(pending, new JavaScriptSerializer().Serialize(selected), new UTF8Encoding(false));
            if (File.Exists(destination)) File.Replace(pending, destination, null);
            else File.Move(pending, destination);
            settings = selected;
            ConfigurationChanged = true;
            status.Text = "设置已保存。返回字幕软件后重启本地服务生效；没有开启麦克风。";
            return true;
        }

        private void OpenCodexLogin()
        {
            string executable = fields["codexExecutable"].Text.Trim();
            if (executable.Length == 0) executable = FindCodex();
            if (!File.Exists(executable)) throw new SafeFailure("desktop_codex_executable_missing");
            // Explicit button action only. Official CLI manages login; no auth file is read or copied.
            Process.Start(new ProcessStartInfo(executable, "login") { UseShellExecute = true });
            status.Text = "已打开官方 Codex 登录命令。已有登录无需再次登录；请勿在软件或聊天中输入 Token。";
        }

        private static string FindCodex()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string official = Path.Combine(local, "OpenAI", "Codex", "bin");
            string latest = null; DateTime modified = DateTime.MinValue;
            if (Directory.Exists(official)) foreach (string directory in Directory.GetDirectories(official))
            {
                string file = Path.Combine(directory, "codex.exe");
                if (File.Exists(file) && File.GetLastWriteTimeUtc(file) > modified)
                { latest = file; modified = File.GetLastWriteTimeUtc(file); }
            }
            if (latest != null) return latest;
            foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                if (directory.Length == 0) continue;
                string file = Path.Combine(directory, "codex.exe");
                if (File.Exists(file)) return file;
            }
            return Path.Combine(SoftwarePaths.SharedRoot, "runtime", "codex", "codex.exe");
        }

        private void OpenWebViewHelp()
        {
            Process.Start(new ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/#download-section") { UseShellExecute = true });
            status.Text = "已打开微软官方 WebView2 下载页。安装 Evergreen Runtime x64 后重试启动字幕界面。";
        }

        private void OnUi(Action action)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke(action); } catch (InvalidOperationException) { }
        }

        private static Dictionary<string, object> DefaultSettings()
        {
            Dictionary<string, object> value = new Dictionary<string, object>();
            value["schemaVersion"] = 1;
            value["pythonExecutable"] = Path.Combine(SoftwarePaths.SharedRoot, "runtime", "python", "python.exe");
            value["modelDirectory"] = Path.Combine(SoftwarePaths.SharedRoot, "models", "large-v3");
            value["speakerAssets"] = Path.Combine(SoftwarePaths.SharedRoot, "models", "speaker");
            value["codexExecutable"] = "";
            value["dataDirectory"] = Path.Combine(SoftwarePaths.SharedRoot, "data");
            return value;
        }

        private static Dictionary<string, object> ReadSettings(string root)
        {
            Dictionary<string, object> value = ReadJson(Path.Combine(root, "launcher.settings.json"));
            string user = Path.Combine(SoftwarePaths.SharedRoot, "desktop.settings.json");
            if (File.Exists(user))
            {
                Dictionary<string, object> overrides = ReadJson(user);
                object schema;
                if (!overrides.TryGetValue("schemaVersion", out schema) || !(schema is int) || (int)schema != 1)
                    throw new SafeFailure("desktop_invalid_user_settings");
                foreach (KeyValuePair<string, object> entry in overrides)
                {
                    if (entry.Key == "schemaVersion") continue;
                    if (Array.IndexOf(new string[] { "pythonExecutable", "modelDirectory", "speakerAssets", "codexExecutable",
                        "dataDirectory", "codexModel", "codexServiceTier" }, entry.Key) < 0)
                        throw new SafeFailure("desktop_invalid_user_settings");
                    value[entry.Key] = entry.Value;
                }
            }
            foreach (string key in new string[] { "pythonExecutable", "modelDirectory", "speakerAssets", "codexExecutable", "dataDirectory" })
            {
                string path = StringValue(value, key);
                if (path.StartsWith("{shared}/", StringComparison.Ordinal) || path.StartsWith("{shared}\\", StringComparison.Ordinal))
                {
                    string relative = path.Substring(9);
                    foreach (string part in relative.Split(new char[] { '/', '\\' }))
                        if (part.Length == 0 || part == "." || part == ".." || part.Contains("{") || part.Contains("}"))
                            throw new SafeFailure("desktop_invalid_settings");
                    value[key] = Path.Combine(SoftwarePaths.SharedRoot, relative.Replace('/', Path.DirectorySeparatorChar));
                }
            }
            return value;
        }

        private static Dictionary<string, object> ReadJson(string path)
        {
            if (new FileInfo(path).Length > 65536) throw new SafeFailure("desktop_invalid_settings");
            Dictionary<string, object> value = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 32 }
                .DeserializeObject(File.ReadAllText(path, Encoding.UTF8)) as Dictionary<string, object>;
            if (value == null) throw new SafeFailure("desktop_invalid_settings");
            return value;
        }

        private static string Missing(Dictionary<string, object> value)
        {
            List<string> missing = new List<string>();
            if (!File.Exists(StringValue(value, "pythonExecutable"))) missing.Add("Python 运行环境");
            string model = StringValue(value, "modelDirectory");
            if (!File.Exists(Path.Combine(model, "model.bin")) || !File.Exists(Path.Combine(model, "download-manifest.json"))) missing.Add("Whisper 识别模型");
            if (!File.Exists(Path.Combine(StringValue(value, "speakerAssets"), "manifest.json"))) missing.Add("声纹模型");
            return string.Join("、", missing.ToArray());
        }

        private static string StringValue(Dictionary<string, object> value, string key)
        {
            object item;
            return value.TryGetValue(key, out item) ? item as string ?? "" : "";
        }

        private static string SafeCode(string value)
        {
            return System.Text.RegularExpressions.Regex.IsMatch(value, "^[a-z][a-z0-9_]{0,99}$") ? value : "software_update_failed";
        }

        private static string ProgressText(string stage)
        {
            if (stage.Contains("verif") || stage.Contains("hash")) return "正在校验下载文件完整性……";
            if (stage.Contains("extract") || stage.Contains("stage")) return "正在准备安装文件……";
            if (stage.Contains("release") || stage.Contains("manifest")) return "正在获取 GitHub 发布信息……";
            if (stage.Contains("check")) return "正在检查 GitHub 发布信息……";
            return "正在从 GitHub 下载，请保持软件开启……";
        }

        private static string Friendly(string code)
        {
            if (code == "software_download_cancelled") return "已取消下载，临时 .part 文件保留；未安装更新，字幕软件可继续使用。";
            if (code == "software_backend_stop_required") return "已取消安装：字幕服务尚未正常停止。停止采音与任务后重试。";
            if (code == "desktop_codex_executable_missing") return "未找到 Codex 程序。请下载识别环境，或选择已有官方 Codex.exe。";
            if (code == "software_settings_path_invalid") return "设置未保存：请使用完整的本机绝对路径。";
            if (code.Contains("hash") || code.Contains("integrity")) return "下载文件校验失败，已阻止安装。请稍后重试。错误码：" + code;
            if (code.Contains("release") || code.Contains("not_found")) return "GitHub 尚无可用发布或文件不存在。当前版本仍可使用。错误码：" + code;
            return "操作未完成（" + code + "）。请检查网络、发布文件和目录权限后重试。";
        }

        private static string Quote(string value)
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
    }
}
