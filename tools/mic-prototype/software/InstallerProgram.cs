using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace BilibiliSubtitlePrototype
{
    internal static class InstallerProgram
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                if (args.Length == 4 && args[0] == "--apply-update" && args[2] == "--wait-pid")
                {
                    int pid;
                    if (!Int32.TryParse(args[3], out pid) || pid <= 0) throw new InvalidDataException("parent_pid_invalid");
                    try { using (Process parent = Process.GetProcessById(pid)) { if (!parent.WaitForExit(95000)) throw new InvalidDataException("previous_app_still_running"); } }
                    catch (ArgumentException) { }
                    string launcher = SoftwareInstall.ApplyUpdate(Path.GetFullPath(args[1]));
                    if (UseShortcuts(Path.GetDirectoryName(launcher))) RegisterSoftware(Path.GetDirectoryName(launcher), CurrentVersion(Path.GetDirectoryName(launcher)), true);
                    Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(launcher) });
                    SoftwareInstall.WriteNewJson(Path.Combine(Path.GetDirectoryName(args[1]), "install-result.json"), new { success = true, phase = "installed_and_restart_requested", version = CurrentVersion(Path.GetDirectoryName(launcher)), atUtc = DateTime.UtcNow.ToString("o") });
                    return 0;
                }
                if (args.Length == 1 && args[0] == "--uninstall") return Uninstall();
                if (args.Length == 1 && args[0] == "--uninstall-confirmed") return RemoveApplication();
                bool silent = args.Length == 1 && args[0] == "--install-silent-no-launch";
                if (args.Length != 0 && !silent) return 1;
                if (silent) { Install(false, false); return 0; }
                Application.Run(new InstallWindow()); return 0;
            }
            catch (Exception error)
            {
                string code = error is InvalidDataException ? error.Message : "software_install_failed";
                if (args.Length == 1 && args[0] == "--install-silent-no-launch") { Console.Error.WriteLine(code); return 1; }
                MessageBox.Show("操作未完成，现有模型、设置和登录仍保留。\r\n错误：" + code, "主播双语字幕", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
        private static string CurrentVersion(string root)
        {
            return SoftwareInstall.Text(SoftwareInstall.ReadJson(Path.Combine(root, "current.json"), 16384), "version");
        }
        internal static string Install(bool launch, bool shortcuts)
        {
            string folder = Path.Combine(SoftwarePaths.SharedRoot, "updates", "setup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder);
            string archive = Path.Combine(folder, "app.zip");
            Assembly own = Assembly.GetExecutingAssembly();
            using (Stream input = own.GetManifestResourceStream("app.zip"))
            {
                if (input == null) throw new InvalidDataException("installer_payload_missing");
                using (FileStream output = new FileStream(archive, FileMode.CreateNew, FileAccess.Write, FileShare.None)) input.CopyTo(output);
            }
            string releaseFile = Path.Combine(folder, "software-release.json");
            using (Stream input = own.GetManifestResourceStream("software-release.json"))
            {
                if (input == null) throw new InvalidDataException("installer_version_missing");
                using (FileStream output = new FileStream(releaseFile, FileMode.CreateNew, FileAccess.Write, FileShare.None)) input.CopyTo(output);
            }
            string version = SoftwareInstall.Text(SoftwareInstall.ReadJson(releaseFile, 65536), "version");
            string root = SoftwarePaths.InstallRoot(AppDomain.CurrentDomain.BaseDirectory);
            string launcher = SoftwareInstall.InstallApplication(archive, version, root, true);
            SoftwareInstall.AtomicJson(Path.Combine(root, "installation.json"), new { schemaVersion = 1, shortcutsEnabled = shortcuts });
            if (shortcuts) RegisterSoftware(root, version, true);
            SoftwareInstall.WriteNewJson(Path.Combine(folder, "install-result.json"), new { success = true, version = version, installRoot = root, shortcuts = shortcuts, atUtc = DateTime.UtcNow.ToString("o"), credentialsBundled = false });
            if (launch) Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true, WorkingDirectory = root });
            return launcher;
        }
        private static readonly string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\StreamerBilingualSubtitles";
        private static bool UseShortcuts(string root)
        {
            string path = Path.Combine(root, "installation.json");
            if (!File.Exists(path)) return true;
            object value;
            return SoftwareInstall.ReadJson(path, 16384).TryGetValue("shortcutsEnabled", out value) && value is bool && (bool)value;
        }
        private static string ShortcutDirectory { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "主播双语字幕"); } }
        private static string DesktopShortcut { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "主播双语字幕软件版.lnk"); } }
        private static void Shortcut(string destination, string target, string root)
        {
            object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            object link = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { destination });
            try
            {
                Type type = link.GetType();
                type.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { target });
                type.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { root });
                type.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { "日语识别与中英文双语字幕" });
                type.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
            }
            finally { Marshal.FinalReleaseComObject(link); Marshal.FinalReleaseComObject(shell); }
        }
        private static void RegisterSoftware(string root, string version, bool desktop)
        {
            string launcher = Path.Combine(root, "BilibiliSubtitle.exe");
            Directory.CreateDirectory(ShortcutDirectory);
            Shortcut(Path.Combine(ShortcutDirectory, "主播双语字幕.lnk"), launcher, root);
            if (desktop) Shortcut(DesktopShortcut, launcher, root);
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                key.SetValue("DisplayName", "主播双语字幕"); key.SetValue("DisplayVersion", version);
                key.SetValue("Publisher", "humerus-sketch"); key.SetValue("InstallLocation", root);
                key.SetValue("DisplayIcon", launcher); key.SetValue("URLInfoAbout", "https://github.com/" + SoftwarePaths.Repository);
                key.SetValue("UninstallString", SoftwareInstall.Quote(Path.Combine(root, "Uninstall.exe")) + " --uninstall");
                key.SetValue("NoModify", 1); key.SetValue("NoRepair", 1);
            }
        }
        private static int Uninstall()
        {
            if (MessageBox.Show("卸载程序文件和软件快捷方式？\r\n模型、声纹、设置、运行记录与Codex登录将保留。", "卸载主播双语字幕", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return 0;
            string folder = Path.Combine(SoftwarePaths.SharedRoot, "maintenance", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder); string helper = Path.Combine(folder, "UninstallHelper.exe");
            File.Copy(Assembly.GetExecutingAssembly().Location, helper, false);
            Process.Start(new ProcessStartInfo(helper, "--uninstall-confirmed") { UseShellExecute = true, WorkingDirectory = folder });
            return 0;
        }
        private static int RemoveApplication()
        {
            string root = SoftwarePaths.InstallRoot(AppDomain.CurrentDomain.BaseDirectory);
            string launcher = SoftwarePaths.Contained(root, "BilibiliSubtitle.exe");
            SoftwareInstall.ReadJson(Path.Combine(root, "current.json"), 16384);
            if (SoftwareInstall.Text(SoftwareInstall.ReadJson(Path.Combine(root, "software-install-identity.json"), 16384), "repository") != SoftwarePaths.Repository)
                throw new InvalidDataException("uninstall_root_identity_mismatch");
            if (!File.Exists(launcher)) throw new InvalidDataException("uninstall_root_invalid");
            foreach (Process process in Process.GetProcessesByName("BilibiliSubtitle"))
            {
                try
                {
                    string path = process.MainModule.FileName;
                    if (path.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("please_close_application_before_uninstall");
                }
                catch (InvalidDataException) { throw; }
                catch { }
                finally { process.Dispose(); }
            }
            // This branch is only launched after the explicit uninstall confirmation above.
            SoftwarePaths.NoLinks(root, root);
            Directory.Delete(root, true);
            if (File.Exists(DesktopShortcut)) File.Delete(DesktopShortcut);
            if (Directory.Exists(ShortcutDirectory)) Directory.Delete(ShortcutDirectory, true);
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
            MessageBox.Show("程序已卸载。模型、设置、声纹和登录已保留。", "主播双语字幕"); return 0;
        }
    }
    internal sealed class InstallWindow : Form
    {
        private readonly Button install = new Button();
        private readonly Label state = new Label();
        private bool busy;
        public InstallWindow()
        {
            Text = "安装主播双语字幕"; Font = new Font("Microsoft YaHei UI", 10F);
            ClientSize = new Size(650, 310); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
            Label title = new Label { Text = "主播双语字幕", Font = new Font(Font.FontFamily, 20F), AutoSize = true, Location = new Point(25, 23) };
            state.Text = "将安装到当前用户，无需管理员权限。\r\n\r\n安装位置：" + SoftwarePaths.InstallRoot(AppDomain.CurrentDomain.BaseDirectory)
                + "\r\n\r\n首次运行可在软件内下载识别环境与模型，或选择已有目录。\r\n需要NVIDIA显卡驱动；翻译使用你自己的Codex登录。";
            state.SetBounds(26, 78, 595, 160);
            install.Text = "安装并启动"; install.SetBounds(437, 251, 178, 38);
            install.Click += async delegate
            {
                busy = true; install.Enabled = false; state.Text = "正在安装并校验程序文件……";
                try { await Task.Factory.StartNew(delegate { InstallerProgram.Install(true, true); }); busy = false; Close(); }
                catch (Exception error) { busy = false; install.Enabled = true; state.Text = "安装未完成，旧版本及用户数据保留。\r\n" + (error is InvalidDataException ? error.Message : "software_install_failed"); }
            };
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
            Controls.Add(title); Controls.Add(state); Controls.Add(install);
        }
    }
}
