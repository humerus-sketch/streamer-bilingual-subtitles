using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace BilibiliSubtitlePrototype
{
    internal static class BootstrapProgram
    {
        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                string root = AppDomain.CurrentDomain.BaseDirectory;
                string pointerFile = Path.Combine(root, "current.json");
                var pointer = SoftwareInstall.ReadJson(pointerFile, 16384);
                string version = SoftwareInstall.Text(pointer, "version"); SoftwareInstall.Version(version);
                string executable = SoftwarePaths.Contained(root, "versions/" + version + "/BilibiliSubtitle.exe");
                if (args.Length == 1 && args[0] == "--print-version") { Console.WriteLine(version); return 0; }
                if (args.Length > 0) return 1;
                try
                {
                    if (!File.Exists(executable)) throw new InvalidDataException("installed_version_missing");
                    using (Process child = Process.Start(new ProcessStartInfo(executable) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(executable) }))
                    {
                        // An immediate native launch failure rolls back; this is not an ASR quality check.
                        if (!child.WaitForExit(10000) || child.ExitCode == 0) return 0;
                    }
                }
                catch { /* A missing or unloadable new EXE must use the same retained-version fallback. */ }
                string previous = SoftwareInstall.Text(pointer, "previousVersion");
                if (previous == null || previous == version) throw new InvalidDataException("application_start_failed");
                SoftwareInstall.Version(previous);
                string previousExe = SoftwarePaths.Contained(root, "versions/" + previous + "/BilibiliSubtitle.exe");
                if (!File.Exists(previousExe)) throw new InvalidDataException("previous_version_missing");
                SoftwareInstall.AtomicJson(pointerFile, new { schemaVersion = 1, version = previous, previousVersion = version, rollbackAtUtc = DateTime.UtcNow.ToString("o") });
                Process.Start(new ProcessStartInfo(previousExe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(previousExe) });
                return 0;
            }
            catch
            {
                MessageBox.Show("程序启动未完成。请重新下载安装包修复程序文件；模型、设置和Codex登录仍保留。", "主播双语字幕", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
