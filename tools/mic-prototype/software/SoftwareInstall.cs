using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace BilibiliSubtitlePrototype
{
    internal static class SoftwarePaths
    {
        public const string Repository = "humerus-sketch/streamer-bilingual-subtitles";
        public static string SharedRoot
        {
            get
            {
                string configured = Environment.GetEnvironmentVariable("BILIBILI_SUBTITLE_HOME");
                if (!String.IsNullOrEmpty(configured) && (!Path.IsPathRooted(configured) || Regex.IsMatch(configured, @"[\x00-\x1f]")))
                    throw new InvalidDataException("software_shared_root_invalid");
                return Path.GetFullPath(String.IsNullOrEmpty(configured)
                    ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BilibiliSubtitlePrototype") : configured);
            }
        }
        public static string InstallRoot(string packageRoot)
        {
            string configured = Environment.GetEnvironmentVariable("BILIBILI_SUBTITLE_INSTALL_ROOT");
            if (!String.IsNullOrEmpty(configured))
            {
                if (!Path.IsPathRooted(configured) || Regex.IsMatch(configured, @"[\x00-\x1f]")) throw new InvalidDataException("software_install_root_invalid");
                return Path.GetFullPath(configured);
            }
            DirectoryInfo current = new DirectoryInfo(packageRoot);
            if (current.Parent != null && current.Parent.Name == "versions" && current.Parent.Parent != null)
                return current.Parent.Parent.FullName;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "BilibiliSubtitle");
        }
        public static string Contained(string root, string relative)
        {
            string absoluteRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string result = Path.GetFullPath(Path.Combine(root, relative));
            if (!result.StartsWith(absoluteRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("path_outside_root");
            return result;
        }
        public static void NoLinks(string root, string path)
        {
            string anchor = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            string current = Path.GetFullPath(path);
            if (!String.Equals(current, anchor, StringComparison.OrdinalIgnoreCase)) Contained(anchor, current);
            while (current.Length >= anchor.Length)
            {
                if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("reparse_point_not_allowed");
                if (String.Equals(current, anchor, StringComparison.OrdinalIgnoreCase)) break;
                current = Path.GetDirectoryName(current);
                if (current == null) break;
            }
        }
    }

    internal static class SoftwareInstall
    {
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
        public static Dictionary<string, object> ReadJson(string path, int limit)
        {
            FileInfo file = new FileInfo(path);
            if (!file.Exists || file.Length > limit) throw new InvalidDataException("json_missing_or_too_large");
            JavaScriptSerializer parser = new JavaScriptSerializer { MaxJsonLength = limit, RecursionLimit = 32 };
            Dictionary<string, object> value = parser.DeserializeObject(File.ReadAllText(path, Utf8)) as Dictionary<string, object>;
            if (value == null) throw new InvalidDataException("json_object_required");
            return value;
        }
        public static string Text(Dictionary<string, object> value, string key)
        {
            object result;
            return value.TryGetValue(key, out result) ? result as string : null;
        }
        public static long Number(Dictionary<string, object> value, string key)
        {
            object result;
            if (!value.TryGetValue(key, out result)) throw new InvalidDataException("number_missing");
            try { return Convert.ToInt64(result); } catch { throw new InvalidDataException("number_invalid"); }
        }
        public static IEnumerable Items(Dictionary<string, object> value, string key)
        {
            object result;
            if (!value.TryGetValue(key, out result) || result is string || !(result is IEnumerable)) throw new InvalidDataException("array_missing");
            return (IEnumerable)result;
        }
        public static void Version(string version)
        {
            if (version == null || !Regex.IsMatch(version, @"^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$"))
                throw new InvalidDataException("version_invalid");
        }
        public static string Hash(string path)
        {
            using (SHA256 algorithm = SHA256.Create())
            using (FileStream stream = File.OpenRead(path))
                return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
        public static void CheckFile(string path, long bytes, string hash)
        {
            if (bytes <= 0 || hash == null || !Regex.IsMatch(hash, "^[a-f0-9]{64}$") || !File.Exists(path)
                || new FileInfo(path).Length != bytes || !String.Equals(Hash(path), hash, StringComparison.Ordinal))
                throw new InvalidDataException("file_size_or_sha256_mismatch");
        }
        public static void WriteNewJson(string path, object value)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            using (FileStream stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (StreamWriter writer = new StreamWriter(stream, Utf8))
            {
                writer.Write(new JavaScriptSerializer().Serialize(value));
                writer.Flush(); stream.Flush(true);
            }
        }
        public static void AtomicJson(string path, object value)
        {
            string temporary = path + ".pending-" + Guid.NewGuid().ToString("N");
            WriteNewJson(temporary, value);
            if (File.Exists(path)) File.Replace(temporary, path, path + ".previous-" + Guid.NewGuid().ToString("N"));
            else File.Move(temporary, path);
        }
        private static void SafeEntry(string name)
        {
            if (String.IsNullOrEmpty(name) || name.Length > 220 || name.StartsWith("/") || name.IndexOf('\\') >= 0
                || name.IndexOfAny(new char[] { ':', '<', '>', '"', '|', '?', '*' }) >= 0 || Regex.IsMatch(name, @"[\x00-\x1f\x7f]"))
                throw new InvalidDataException("zip_path_invalid");
            string trimmed = name.TrimEnd('/');
            foreach (string part in trimmed.Split('/'))
            {
                if (part == "" || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ")
                    || Regex.IsMatch(part, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", RegexOptions.IgnoreCase))
                    throw new InvalidDataException("zip_path_invalid");
            }
        }
        // Never use blind ExtractToDirectory: ZIP entries are untrusted even after a download checksum.
        public static void ExtractZip(string zipPath, string destination, long expandedLimit)
        {
            if (Directory.Exists(destination) || File.Exists(destination)) throw new InvalidDataException("extraction_target_exists");
            Directory.CreateDirectory(destination);
            HashSet<string> paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long declared = 0, actual = 0;
            using (ZipArchive archive = ZipFile.OpenRead(zipPath))
            {
                if (archive.Entries.Count == 0 || archive.Entries.Count > 100000) throw new InvalidDataException("zip_entry_limit");
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    SafeEntry(entry.FullName);
                    if (!paths.Add(entry.FullName.TrimEnd('/'))) throw new InvalidDataException("zip_duplicate_path");
                    int unixKind = (entry.ExternalAttributes >> 16) & 0xF000;
                    if (unixKind == 0xA000 || (entry.ExternalAttributes & 0x400) != 0) throw new InvalidDataException("zip_link_not_allowed");
                    if (entry.Length < 0 || entry.Length > expandedLimit || declared > expandedLimit - entry.Length) throw new InvalidDataException("zip_expanded_size_limit");
                    declared += entry.Length;
                    string target = SoftwarePaths.Contained(destination, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                    SoftwarePaths.NoLinks(destination, Path.GetDirectoryName(target));
                    if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream input = entry.Open())
                    using (FileStream output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        byte[] buffer = new byte[1024 * 1024];
                        long length = 0; int count;
                        while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            length += count; actual += count;
                            if (length > entry.Length || actual > expandedLimit) throw new InvalidDataException("zip_expanded_size_limit");
                            output.Write(buffer, 0, count);
                        }
                        if (length != entry.Length) throw new InvalidDataException("zip_entry_truncated");
                    }
                }
            }
        }
        public static void VerifyApplication(string root, string version)
        {
            Version(version);
            Dictionary<string, object> release = ReadJson(Path.Combine(root, "software-release.json"), 65536);
            if (Text(release, "version") != version || Text(release, "repository") != SoftwarePaths.Repository)
                throw new InvalidDataException("app_release_identity_mismatch");
            foreach (string file in new string[] { "BilibiliSubtitle.exe", "runtime/node.exe", "launcher.settings.json", "SubtitleMaintenance.exe", "BilibiliSubtitleBootstrap.exe" })
                if (!File.Exists(SoftwarePaths.Contained(root, file))) throw new InvalidDataException("app_required_file_missing");
            Dictionary<string, object> manifest = ReadJson(Path.Combine(root, "package-manifest.json"), 8 * 1024 * 1024);
            HashSet<string> expected = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            expected.Add("package-manifest.json");
            foreach (object item in Items(manifest, "files"))
            {
                Dictionary<string, object> row = item as Dictionary<string, object>;
                if (row == null) throw new InvalidDataException("app_manifest_invalid");
                string relative = Text(row, "path"); SafeEntry(relative);
                if (!expected.Add(relative)) throw new InvalidDataException("app_manifest_duplicate");
                CheckFile(SoftwarePaths.Contained(root, relative), Number(row, "bytes"), Text(row, "sha256"));
            }
            foreach (string file in Directory.GetFiles(root, "*", SearchOption.AllDirectories))
            {
                string relative = file.Substring(root.TrimEnd('\\').Length + 1).Replace('\\', '/');
                if (!expected.Contains(relative)) throw new InvalidDataException("app_unlisted_file");
            }
        }
        private static Dictionary<string, object> Plan(string path, string kind)
        {
            string updates = Path.Combine(SoftwarePaths.SharedRoot, "updates");
            SoftwarePaths.Contained(updates, path); SoftwarePaths.NoLinks(updates, path);
            Dictionary<string, object> plan = ReadJson(path, 1024 * 1024);
            if (Number(plan, "schemaVersion") != 1 || Text(plan, "kind") != kind || Text(plan, "repository") != SoftwarePaths.Repository)
                throw new InvalidDataException("update_plan_invalid");
            return plan;
        }
        private static string PlanZip(string planPath, Dictionary<string, object> plan, bool component)
        {
            string path = Text(plan, "zipPath");
            if (path == null) throw new InvalidDataException("update_zip_missing");
            string directory = Path.GetDirectoryName(Path.GetFullPath(planPath));
            SoftwarePaths.Contained(directory, path); SoftwarePaths.NoLinks(directory, path);
            CheckFile(path, Number(plan, component ? "archiveBytes" : "bytes"), Text(plan, component ? "archiveSha256" : "sha256"));
            return path;
        }
        public static string StageUpdateHelper(string packageRoot, string planPath)
        {
            Dictionary<string, object> plan = Plan(planPath, "app");
            Version(Text(plan, "version")); PlanZip(planPath, plan, false);
            string target = Path.Combine(Path.GetDirectoryName(planPath), "SubtitleMaintenance.exe");
            if (File.Exists(target)) throw new InvalidDataException("update_helper_already_staged");
            File.Copy(Path.Combine(packageRoot, "SubtitleMaintenance.exe"), target, false);
            WriteNewJson(Path.Combine(Path.GetDirectoryName(planPath), "install-target.json"), new { installRoot = SoftwarePaths.InstallRoot(packageRoot) });
            return target;
        }
        public static string ApplyUpdate(string planPath)
        {
            Dictionary<string, object> plan = Plan(planPath, "app");
            string zip = PlanZip(planPath, plan, false);
            string targetFile = Path.Combine(Path.GetDirectoryName(planPath), "install-target.json");
            string root = Text(ReadJson(targetFile, 16384), "installRoot");
            if (!Path.IsPathRooted(root)) throw new InvalidDataException("install_root_invalid");
            // This target was produced by our running native client, not by a web request.
            if (Path.GetFullPath(root) != Path.GetFullPath(SoftwarePaths.InstallRoot(AppDomain.CurrentDomain.BaseDirectory)))
                throw new InvalidDataException("install_root_mismatch");
            return InstallApplication(zip, Text(plan, "version"), root, false);
        }
        public static string InstallApplication(string zip, string version, string installRoot, bool allowSame)
        {
            Version(version); Directory.CreateDirectory(installRoot); SoftwarePaths.NoLinks(installRoot, installRoot);
            string shared = SoftwarePaths.SharedRoot;
            if (String.Equals(Path.GetFullPath(installRoot).TrimEnd('\\'), shared.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)
                || shared.StartsWith(Path.GetFullPath(installRoot).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("install_root_cannot_contain_user_data");
            string pointerFile = Path.Combine(installRoot, "current.json");
            Dictionary<string, object> previous = File.Exists(pointerFile) ? ReadJson(pointerFile, 16384) : null;
            string old = previous == null ? null : Text(previous, "version");
            string identity = Path.Combine(installRoot, "software-install-identity.json");
            if (!File.Exists(identity))
            {
                if (Directory.GetFileSystemEntries(installRoot).Length > 0 && old == null)
                    throw new InvalidDataException("install_target_not_empty");
                if (old != null)
                {
                    Version(old);
                    var oldRelease = ReadJson(SoftwarePaths.Contained(installRoot, "versions/" + old + "/software-release.json"), 65536);
                    if (Text(oldRelease, "repository") != SoftwarePaths.Repository) throw new InvalidDataException("install_target_identity_mismatch");
                }
                WriteNewJson(identity, new { schemaVersion = 1, repository = SoftwarePaths.Repository });
            }
            else if (Text(ReadJson(identity, 16384), "repository") != SoftwarePaths.Repository)
                throw new InvalidDataException("install_target_identity_mismatch");
            if (old != null)
            {
                Version(old); int compare = new System.Version(version).CompareTo(new System.Version(old));
                if (compare < 0 || compare == 0 && !allowSame) throw new InvalidDataException("update_not_newer");
            }
            string versions = Path.Combine(installRoot, "versions"); Directory.CreateDirectory(versions);
            SoftwarePaths.NoLinks(installRoot, versions);
            string target = SoftwarePaths.Contained(versions, version);
            SoftwarePaths.NoLinks(installRoot, target);
            if (!Directory.Exists(target))
            {
                string staging = SoftwarePaths.Contained(versions, ".staging-" + Guid.NewGuid().ToString("N"));
                ExtractZip(zip, staging, 768L * 1024 * 1024);
                VerifyApplication(staging, version);
                Directory.Move(staging, target);
            }
            else
            {
                try { VerifyApplication(target, version); }
                catch (InvalidDataException)
                {
                    if (!allowSame) throw;
                    string repaired = SoftwarePaths.Contained(versions, ".repair-" + Guid.NewGuid().ToString("N"));
                    ExtractZip(zip, repaired, 768L * 1024 * 1024); VerifyApplication(repaired, version);
                    string retained = target + ".damaged-" + Guid.NewGuid().ToString("N");
                    Directory.Move(target, retained);
                    try { Directory.Move(repaired, target); }
                    catch { Directory.Move(retained, target); throw; }
                }
            }
            string bootstrap = Path.Combine(installRoot, "BilibiliSubtitle.exe");
            ReplaceManagedFile(Path.Combine(target, "BilibiliSubtitleBootstrap.exe"), bootstrap);
            string uninstaller = Path.Combine(installRoot, "Uninstall.exe");
            ReplaceManagedFile(Path.Combine(target, "SubtitleMaintenance.exe"), uninstaller);
            AtomicJson(pointerFile, new { schemaVersion = 1, version = version, previousVersion = old == version ? Text(previous, "previousVersion") : old, activatedAtUtc = DateTime.UtcNow.ToString("o") });
            return bootstrap;
        }
        private static void ReplaceManagedFile(string source, string target)
        {
            if (!File.Exists(target)) { File.Copy(source, target, false); return; }
            if (Hash(source) == Hash(target)) return;
            string pending = target + ".pending-" + Guid.NewGuid().ToString("N");
            File.Copy(source, pending, false);
            File.Replace(pending, target, target + ".previous-" + Guid.NewGuid().ToString("N"));
        }
        public static void InstallComponents(string planPath)
        {
            Dictionary<string, object> plan = Plan(planPath, "components");
            List<string[]> prepared = new List<string[]>();
            HashSet<string> ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (object item in Items(plan, "components"))
            {
                Dictionary<string, object> row = item as Dictionary<string, object>;
                if (row == null) throw new InvalidDataException("component_plan_invalid");
                string id = Text(row, "id"), relative = Text(row, "target");
                string expected = id == "python" ? "runtime/python" : id == "whisper-large-v3" ? "models/large-v3" : id == "speaker-campp" ? "models/speaker" : id == "codex-cli" ? "runtime/codex" : null;
                if (expected == null || relative != expected || !ids.Add(id)) throw new InvalidDataException("component_target_invalid");
                string zip = PlanZip(planPath, row, true);
                long declared = Number(row, "expandedBytes");
                if (declared <= 0 || declared > 16L * 1024 * 1024 * 1024) throw new InvalidDataException("component_size_invalid");
                string target = SoftwarePaths.Contained(SoftwarePaths.SharedRoot, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target)); SoftwarePaths.NoLinks(SoftwarePaths.SharedRoot, target);
                string staging = target + ".pending-" + Guid.NewGuid().ToString("N");
                ExtractZip(zip, staging, declared);
                foreach (object required in Items(row, "requiredFiles"))
                {
                    string name = required as string; SafeEntry(name);
                    if (!File.Exists(SoftwarePaths.Contained(staging, name))) throw new InvalidDataException("component_required_file_missing");
                }
                prepared.Add(new string[] { target, staging, target + ".previous-" + Guid.NewGuid().ToString("N"), "prepared" });
            }
            if (prepared.Count == 0) throw new InvalidDataException("component_plan_empty");
            try
            {
                foreach (string[] entry in prepared)
                {
                    if (Directory.Exists(entry[0])) { Directory.Move(entry[0], entry[2]); entry[3] = "old_moved"; }
                    Directory.Move(entry[1], entry[0]); entry[3] = "activated";
                }
                AtomicJson(Path.Combine(SoftwarePaths.SharedRoot, "components-installed.json"), new { schemaVersion = 1, installedAtUtc = DateTime.UtcNow.ToString("o"), sourcePlan = Path.GetFileName(planPath), components = ids });
            }
            catch
            {
                for (int index = prepared.Count - 1; index >= 0; index--)
                {
                    string[] entry = prepared[index];
                    if (entry[3] == "activated" && Directory.Exists(entry[0])) Directory.Move(entry[0], entry[1]);
                    if ((entry[3] == "activated" || entry[3] == "old_moved") && Directory.Exists(entry[2])) Directory.Move(entry[2], entry[0]);
                }
                throw;
            }
        }
        public static string Quote(string value)
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
