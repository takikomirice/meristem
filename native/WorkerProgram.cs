using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

internal static class WorkerProgram
{
    private static void CreateCanary(string file,string text) {
        using(var stream=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
            byte[] bytes=Encoding.UTF8.GetBytes(text);
            stream.Write(bytes,0,bytes.Length);
        }
    }
    private static int ProbeReadOnly(string[] args) {
        Guid nonce;
        if(args.Length<17 || !Console.IsInputRedirected || !Path.IsPathRooted(args[1]) ||
           !Path.IsPathRooted(args[3]) || !Path.IsPathRooted(args[4]) || !Guid.TryParseExact(args[5],"D",out nonce) ||
           args[6]!="sandbox" || args[7]!="-C" || args[8]!=args[4] || args[9]!="-P" || args[10]!="meristem-read-only" ||
           !String.Equals(Program.Hash(args[1]),args[2],StringComparison.OrdinalIgnoreCase)) return 126;
        var sandboxArgs=new string[args.Length-6];Array.Copy(args,6,sandboxArgs,0,sandboxArgs.Length);
        string secret=Path.Combine(args[3],"isolation-"+nonce),visible=Path.Combine(args[4],".meristem-isolation-"+nonce);
        bool ownSecret=false,ownVisible=false;
        using(var self=Process.GetCurrentProcess())
        using(var cli=McpPeer.VerifiedParent(self))
        using(var shell=cli==null?null:McpPeer.VerifiedParent(cli)) {
            if(shell==null)return 126;
            try {
                CreateCanary(secret,"private-control-canary");ownSecret=true;
                CreateCanary(visible,"visible");ownVisible=true;
                using(var job=new ProcessTree(args[1],sandboxArgs,args[4])) {
                    var cancelled=new ManualResetEvent(false);
                    Program.Background(delegate { try { Console.OpenStandardInput().CopyTo(Stream.Null); } catch(IOException) {} finally { cancelled.Set(); } });
                    Program.Background(delegate { try { job.Output.CopyTo(Stream.Null); } catch(IOException) {} catch(ObjectDisposedException) {} });
                    Program.Background(delegate { try { job.Error.CopyTo(Stream.Null); } catch(IOException) {} catch(ObjectDisposedException) {} });
                    int result=130;
                    job.Input.Close();
                    if(!shell.HasExited && !cli.HasExited && !cancelled.WaitOne(0)) {
                        job.Resume();
                        var elapsed=Stopwatch.StartNew();
                        while(!shell.HasExited && !cli.HasExited && !cancelled.WaitOne(0) && elapsed.ElapsedMilliseconds<30000) {
                            if(job.WaitForExit(50)) {
                                int exit=job.Wait();result=exit==0 || (exit>=41 && exit<=45)?exit:1;break;
                            }
                        }
                        if(result==130 && elapsed.ElapsedMilliseconds>=30000)result=124;
                    }
                    // The root can exit while its sandbox descendants still run.
                    return job.StopAndConfirm(5000)?result:125;
                }
            } finally {
                if(ownVisible)File.Delete(visible);
                if(ownSecret)File.Delete(secret);
            }
        }
    }
    private static int Main(string[] args) {
        try {
            if(args.Length==2 && args[0]=="--identity") {
                using(var process=System.Diagnostics.Process.GetProcessById(Int32.Parse(args[1])))Console.WriteLine(LocalPipe.Created(process));
                return 0;
            }
            if(args.Length>0 && args[0]=="--probe-read-only") return ProbeReadOnly(args);
            return WorkerHost.Run(args);
        }
        catch (Exception e) { Console.Error.WriteLine("worker-host-failed: "+e); return 125; }
    }
}
