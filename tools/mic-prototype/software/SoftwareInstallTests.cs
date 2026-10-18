using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;

namespace BilibiliSubtitlePrototype
{
    internal static class SoftwareInstallTests
    {
        private static string root;
        private static readonly List<object> results = new List<object>();
        private static void Assert(bool passed, string name)
        {
            if (!passed) throw new Exception("assertion_failed:" + name);
            results.Add(new { name = name, passed = true });
        }
        private static string Zip(string name, Action<ZipArchive> populate)
        {
            string file = Path.Combine(root, name + ".zip");
            using (ZipArchive zip = ZipFile.Open(file, ZipArchiveMode.Create)) populate(zip);
            return file;
        }
        private static void Entry(ZipArchive zip, string name, string text)
        {
            using (StreamWriter writer = new StreamWriter(zip.CreateEntry(name).Open(), new UTF8Encoding(false))) writer.Write(text);
        }
        private static void Rejected(Action action, string name)
        {
            bool failed = false;
            try { action(); } catch (InvalidDataException) { failed = true; }
            Assert(failed, name);
        }
        private static Dictionary<string, object> AppPlan(string folder, string archive, string version)
        {
            string copied = Path.Combine(folder, "app.zip"); File.Copy(archive, copied);
            return new Dictionary<string, object> { { "schemaVersion", 1 }, { "kind", "app" }, { "version", version },
                { "repository", SoftwarePaths.Repository }, { "zipPath", copied }, { "bytes", new FileInfo(copied).Length }, { "sha256", SoftwareInstall.Hash(copied) } };
        }
        private static Dictionary<string, object> Component(string folder, string id, string target, string content)
        {
            string archive = Zip(id + "-" + Guid.NewGuid().ToString("N"), delegate(ZipArchive zip) { Entry(zip, "required.bin", content); });
            string copied = Path.Combine(folder, id + ".zip"); File.Copy(archive, copied);
            return new Dictionary<string, object> { { "id", id }, { "target", target }, { "zipPath", copied },
                { "archiveBytes", new FileInfo(copied).Length }, { "archiveSha256", SoftwareInstall.Hash(copied) },
                { "expandedBytes", 4096 }, { "requiredFiles", new string[] { "required.bin" } } };
        }
        private static int Main(string[] args)
        {
            if (args.Length != 3) return 1;
            root = Path.GetFullPath(args[0]); Directory.CreateDirectory(root);
            string shared = Path.Combine(root, "shared"), install = Path.Combine(root, "installed software");
            Environment.SetEnvironmentVariable("BILIBILI_SUBTITLE_HOME", shared);
            Environment.SetEnvironmentVariable("BILIBILI_SUBTITLE_INSTALL_ROOT", install);
            try
            {
                foreach (string invalid in new string[] { "../escape.txt", "/absolute.txt", "C:/drive.txt", "folder\\escape.txt", "file.txt:stream", "CON.txt", "space /x", "x/../a" })
                {
                    string copy = invalid;
                    string zip = Zip("invalid-" + results.Count, delegate(ZipArchive archive) { Entry(archive, copy, "blocked"); });
                    Rejected(delegate { SoftwareInstall.ExtractZip(zip, Path.Combine(root, "extract-" + results.Count), 1024); }, "reject_path:" + invalid);
                }
                string duplicate = Zip("duplicate", delegate(ZipArchive zip) { Entry(zip, "Same.txt", "a"); Entry(zip, "same.txt", "b"); });
                Rejected(delegate { SoftwareInstall.ExtractZip(duplicate, Path.Combine(root, "duplicates"), 1024); }, "reject_case_insensitive_duplicates");
                string symlink = Zip("symlink", delegate(ZipArchive zip) { ZipArchiveEntry entry = zip.CreateEntry("link"); entry.ExternalAttributes = unchecked((int)0xA1FF0000); });
                Rejected(delegate { SoftwareInstall.ExtractZip(symlink, Path.Combine(root, "links"), 1024); }, "reject_zip_symlink");
                string oversized = Zip("oversized", delegate(ZipArchive zip) { Entry(zip, "big.txt", new string('x', 2000)); });
                Rejected(delegate { SoftwareInstall.ExtractZip(oversized, Path.Combine(root, "too-big"), 1000); }, "reject_expanded_size_limit");
                Assert(!File.Exists(Path.Combine(root, "escape.txt")), "no_path_escape_written");
                Directory.CreateDirectory(Path.Combine(shared, "data", "speaker-profiles"));
                string sentinel = Path.Combine(shared, "data", "speaker-profiles", "keep.txt"); File.WriteAllText(sentinel, "keep-user-data");
                string config = Path.Combine(shared, "desktop.settings.json"); File.WriteAllText(config, "{\"keep\":true}");
                string sentinelHash = SoftwareInstall.Hash(sentinel), configHash = SoftwareInstall.Hash(config);
                string launcher = SoftwareInstall.InstallApplication(Path.GetFullPath(args[1]), "0.1.0", install, true);
                Assert(File.Exists(launcher), "initial_install_creates_stable_launcher");
                Assert(SoftwareInstall.Text(SoftwareInstall.ReadJson(Path.Combine(install, "current.json"), 16384), "version") == "0.1.0", "initial_version_activated");
                Rejected(delegate { SoftwareInstall.InstallApplication(Path.GetFullPath(args[1]), "0.0.9", install, false); }, "downgrade_rejected_before_activation");
                Rejected(delegate { SoftwareInstall.InstallApplication(Path.GetFullPath(args[1]), "0.1.0", install, false); }, "same_version_update_rejected");
                string bad = Zip("bad-app", delegate(ZipArchive zip) { Entry(zip, "software-release.json", "{\"version\":\"0.1.1\",\"repository\":\"" + SoftwarePaths.Repository + "\"}"); });
                Rejected(delegate { SoftwareInstall.InstallApplication(bad, "0.1.1", install, false); }, "missing_application_files_rejected");
                Assert(SoftwareInstall.Text(SoftwareInstall.ReadJson(Path.Combine(install, "current.json"), 16384), "version") == "0.1.0", "failed_stage_keeps_old_pointer");
                string originalExe = Path.Combine(install, "versions", "0.1.0", "BilibiliSubtitle.exe");
                string originalExeHash = SoftwareInstall.Hash(originalExe);
                File.WriteAllText(originalExe, "damaged-native-file");
                SoftwareInstall.InstallApplication(Path.GetFullPath(args[1]), "0.1.0", install, true);
                Assert(SoftwareInstall.Hash(originalExe) == originalExeHash, "same_version_setup_repairs_corrupt_files");
                Assert(Directory.GetDirectories(Path.Combine(install, "versions"), "0.1.0.damaged-*").Length == 1, "repair_retains_damaged_version_for_diagnosis");
                string updateFolder = Path.Combine(shared, "updates", "valid-upgrade"); Directory.CreateDirectory(updateFolder);
                string planPath = Path.Combine(updateFolder, "plan.json");
                SoftwareInstall.WriteNewJson(planPath, AppPlan(updateFolder, Path.GetFullPath(args[2]), "0.1.1"));
                string helper = SoftwareInstall.StageUpdateHelper(Path.Combine(install, "versions", "0.1.0"), planPath);
                Assert(File.Exists(helper), "helper_staged_outside_running_version");
                SoftwareInstall.ApplyUpdate(planPath);
                var pointer = SoftwareInstall.ReadJson(Path.Combine(install, "current.json"), 16384);
                Assert(SoftwareInstall.Text(pointer, "version") == "0.1.1" && SoftwareInstall.Text(pointer, "previousVersion") == "0.1.0", "new_version_activated_with_rollback_pointer");
                Assert(File.Exists(Path.Combine(install, "versions", "0.1.0", "BilibiliSubtitle.exe")), "old_version_retained");
                string compFolder = Path.Combine(shared, "updates", "components"); Directory.CreateDirectory(compFolder);
                var python = Component(compFolder, "python", "runtime/python", "new-runtime");
                var speaker = Component(compFolder, "speaker-campp", "models/speaker", "new-speaker");
                string compPlan = Path.Combine(compFolder, "plan.json");
                SoftwareInstall.WriteNewJson(compPlan, new { schemaVersion = 1, kind = "components", repository = SoftwarePaths.Repository, components = new object[] { python, speaker } });
                SoftwareInstall.InstallComponents(compPlan);
                Assert(File.ReadAllText(Path.Combine(shared, "runtime", "python", "required.bin")) == "new-runtime", "component_archives_installed");
                string invalidFolder = Path.Combine(shared, "updates", "bad-components"); Directory.CreateDirectory(invalidFolder);
                var first = Component(invalidFolder, "python", "runtime/python", "must-not-activate");
                var second = Component(invalidFolder, "speaker-campp", "models/speaker", "invalid"); second["archiveSha256"] = new string('0', 64);
                string invalidPlan = Path.Combine(invalidFolder, "plan.json");
                SoftwareInstall.WriteNewJson(invalidPlan, new { schemaVersion = 1, kind = "components", repository = SoftwarePaths.Repository, components = new object[] { first, second } });
                Rejected(delegate { SoftwareInstall.InstallComponents(invalidPlan); }, "bad_second_component_blocks_entire_activation");
                Assert(File.ReadAllText(Path.Combine(shared, "runtime", "python", "required.bin")) == "new-runtime", "bad_component_keeps_previous_runtime");
                Assert(SoftwareInstall.Hash(sentinel) == sentinelHash && SoftwareInstall.Hash(config) == configHash, "voiceprint_and_user_settings_preserved");
                string outsidePlan = Path.Combine(root, "outside-plan.json");
                SoftwareInstall.WriteNewJson(outsidePlan, new { schemaVersion = 1, kind = "app", repository = SoftwarePaths.Repository });
                Rejected(delegate { SoftwareInstall.StageUpdateHelper(Path.Combine(install, "versions", "0.1.1"), outsidePlan); }, "plan_outside_owned_updates_rejected");
                SoftwareInstall.WriteNewJson(Path.Combine(root, "test-results.json"), new { passed = true, tests = results.Count, results = results, realAppArchivesVerified = true, sourceOrCredentialsChanged = false });
                Console.WriteLine("PASS " + results.Count); return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.GetType().Name + ":" + error.Message);
                SoftwareInstall.WriteNewJson(Path.Combine(root, "failed-results.json"), new { passed = false, tests = results.Count, results = results, errorType = error.GetType().Name, code = error.Message }); return 1;
            }
        }
    }
}
