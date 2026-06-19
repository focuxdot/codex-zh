using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace CodexZh
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string script = Path.Combine(root, "launcher", "CodexZhLauncher.ps1");
                if (!File.Exists(script))
                {
                    return 2;
                }

                string powershell = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                    "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
                if (!File.Exists(powershell))
                {
                    powershell = "powershell.exe";
                }

                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = powershell;
                startInfo.Arguments = BuildArguments(script, root, args);
                startInfo.WorkingDirectory = root;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;

                Process process = Process.Start(startInfo);
                if (process == null)
                {
                    return 3;
                }

                if (ShouldWait(args))
                {
                    process.WaitForExit();
                    return process.ExitCode;
                }

                return 0;
            }
            catch
            {
                return 1;
            }
        }

        private static string BuildArguments(string script, string root, string[] args)
        {
            StringBuilder builder = new StringBuilder();
            AppendArgument(builder, "-NoProfile");
            AppendArgument(builder, "-ExecutionPolicy");
            AppendArgument(builder, "Bypass");
            AppendArgument(builder, "-WindowStyle");
            AppendArgument(builder, "Hidden");
            AppendArgument(builder, "-File");
            AppendArgument(builder, script);
            AppendArgument(builder, "-Root");
            AppendArgument(builder, root);

            foreach (string arg in args)
            {
                string mapped = MapArgument(arg);
                if (!string.IsNullOrWhiteSpace(mapped))
                {
                    AppendArgument(builder, mapped);
                }
            }

            return builder.ToString();
        }

        private static string MapArgument(string arg)
        {
            switch ((arg ?? string.Empty).Trim().ToLowerInvariant())
            {
                case "--no-launch":
                case "-nolaunch":
                    return "-NoLaunch";
                case "--self-test":
                case "-selftest":
                    return "-SelfTest";
                case "--print-result":
                case "-printresult":
                    return "-PrintResult";
                case "--configure":
                case "-configure":
                    return "-Configure";
                case "--skip-config":
                case "-skip-config":
                case "-skipconfig":
                    return "-SkipConfig";
                default:
                    return arg;
            }
        }

        private static bool ShouldWait(string[] args)
        {
            foreach (string arg in args)
            {
                string value = (arg ?? string.Empty).Trim().ToLowerInvariant();
                if (value == "--no-launch" || value == "-nolaunch" || value == "--self-test" || value == "-selftest" || value == "--configure" || value == "-configure")
                {
                    return true;
                }
            }
            return false;
        }

        private static void AppendArgument(StringBuilder builder, string value)
        {
            if (builder.Length > 0)
            {
                builder.Append(' ');
            }

            builder.Append('"');
            foreach (char ch in value)
            {
                if (ch == '"' || ch == '\\')
                {
                    builder.Append('\\');
                }
                builder.Append(ch);
            }
            builder.Append('"');
        }
    }
}
