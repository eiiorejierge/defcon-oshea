using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace LoungeLauncher
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            string serverPath = Path.Combine(appDir, "lounge-chat-server.exe");

            if (!File.Exists(serverPath))
            {
                MessageBox.Show(
                    "Error: Could not find 'lounge-chat-server.exe' next to this launcher. Please make sure both files are in the same folder.",
                    "Lounge Chat Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            // Start the server process in the background (no window)
            Process serverProcess = new Process();
            serverProcess.StartInfo.FileName = serverPath;
            serverProcess.StartInfo.WorkingDirectory = appDir;
            serverProcess.StartInfo.UseShellExecute = false;
            serverProcess.StartInfo.CreateNoWindow = true;
            serverProcess.StartInfo.WindowStyle = ProcessWindowStyle.Hidden;

            try
            {
                serverProcess.Start();
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Failed to start the background server: " + ex.Message,
                    "Lounge Chat Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            // Wait a brief moment for the server to spin up
            Thread.Sleep(1500);

            // Launch Edge in app mode (guaranteed to be on all Windows 10/11 machines)
            Process browserProcess = new Process();
            browserProcess.StartInfo.FileName = "msedge.exe";
            browserProcess.StartInfo.Arguments = "--app=http://localhost:3000";

            try
            {
                browserProcess.Start();
            }
            catch (Exception ex)
            {
                // Fallback to default browser
                try
                {
                    Process.Start("http://localhost:3000");
                }
                catch (Exception fallbackEx)
                {
                    MessageBox.Show(
                        "Failed to open web browser: " + fallbackEx.Message,
                        "Lounge Chat Error",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                }
                
                // Clean up server since browser failed
                try
                {
                    if (!serverProcess.HasExited)
                        serverProcess.Kill();
                }
                catch {}
                return;
            }

            // Wait for the browser window to close
            browserProcess.WaitForExit();

            // When the user closes the app window, shut down the background server
            try
            {
                if (!serverProcess.HasExited)
                {
                    serverProcess.Kill();
                }
            }
            catch {}
        }
    }
}
