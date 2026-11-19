using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class Program
{
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength=9*1024*1024, RecursionLimit=100 };
    internal static Dictionary<string, object> Parse(string text) { lock (Json) return Json.Deserialize<Dictionary<string, object>>(text); }
    internal static string Encode(object value) { lock (Json) return Json.Serialize(value); }
    internal static string Text(Dictionary<string, object> d, string key) { object v; return d != null && d.TryGetValue(key, out v) ? v as string : null; }
    internal static Dictionary<string, object> Map(Dictionary<string, object> d, string key) { object v; return d != null && d.TryGetValue(key, out v) ? v as Dictionary<string, object> : null; }
    internal static string Hash(string file) { using (var s=File.OpenRead(file)) using (var h=SHA256.Create()) return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant(); }
    internal static Thread Background(ThreadStart work) { var thread=new Thread(work); thread.IsBackground=true; thread.Start(); return thread; }
    private static void CopyLive(Stream source,Stream destination) { var buffer=new byte[8192]; int count; while((count=source.Read(buffer,0,buffer.Length))>0) { destination.Write(buffer,0,count); destination.Flush(); } }
    // The sidebar keeps its ordinary CODEX_HOME. Configure only this owned App Server invocation.
    private static string[] SidebarArguments(Dictionary<string, object> config, string[] args) {
        var host = Map(config, "controlHost");
        if (Text(host, "sidebarMcp") != "process" || Text(host, "parentMode") != "verified-start") return args;
        string file = Text(host, "configPath");
        if (!Path.IsPathRooted(file) || Hash(file) != Text(host, "configSha256")) throw new InvalidOperationException("sidebar control settings changed");
        var control = Parse(File.ReadAllText(file, Encoding.UTF8));
        var mcp = Map(control, "mcp");
        string node = Text(control, "nodeExecutable"), entry = Text(mcp, "entryPoint"), pipe = Text(control, "pipeName");
        if (!Path.IsPathRooted(node) || !Path.IsPathRooted(entry) || Hash(node) != Text(control, "nodeSha256") ||
            Hash(entry) != Text(mcp, "entrySha256") || !System.Text.RegularExpressions.Regex.IsMatch(pipe ?? "", "^meristem-cc01-control-[a-zA-Z0-9-]{1,90}$"))
            throw new InvalidOperationException("invalid sidebar MCP binding");
        string name = Text(host, "sidebarMcpName") ?? "meristem";
        if (name != "meristem" && name != "meristem_" + (Text(control, "runId") ?? "").Replace("-", "")) throw new InvalidOperationException("invalid managed tool name");
        var options = new List<string>();
        if (name != "meristem") options.AddRange(new[] { "-c", "mcp_servers.meristem.enabled=false" });
        options.AddRange(new[] { "-c", "mcp_servers." + name + "={command=" + Encode(node) +
            ",args=" + Encode(new[] { entry, "--pipe", pipe }) + ",enabled=true}" });
        if (Object.Equals(host.ContainsKey("ideTerminal") ? host["ideTerminal"] : null, true))
            options.AddRange(new[] { "-c", "model_provider=\"openai\"", "-c", "forced_login_method=\"chatgpt\"", "-c", "chatgpt_base_url=\"https://chatgpt.com/backend-api/\"" });
        options.AddRange(args);
        return options.ToArray();
    }
    internal static int Main(string[] args) {
        try {
            string self=Assembly.GetExecutingAssembly().Location;
            var config=Parse(File.ReadAllText(self+".json", Encoding.UTF8));
            string real=Text(config,"realExecutable");
            if (String.IsNullOrEmpty(real) || !Path.IsPathRooted(real) || !real.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("absolute real exe required");
            real=Path.GetFullPath(real);
            if (String.Equals(real, self, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("recursive real exe binding");
            bool verified=String.Equals(Hash(real), Text(config,"realSha256"), StringComparison.OrdinalIgnoreCase);
            if (!verified) Console.Error.WriteLine("Codex identity changed; management disabled. Revalidate before enabling management.");
            // Only the measured stdio app-server invocation enables the side channel.
            bool managed=verified && ((args.Length == 1 && args[0] == "app-server") ||
                    String.Join("\n",args) == "-c\nfeatures.code_mode_host=true\n-c\nfeatures.windows_sandbox_service=true\napp-server\n--analytics-default-enabled");
            var hostConfig = Map(config, "controlHost");
            bool requiresManagement = hostConfig != null && hostConfig.ContainsKey("ideTerminal") && Object.Equals(hostConfig["ideTerminal"], true);
            if (requiresManagement && !managed) return 126;
            string[] forwardedArgs = args;
            if (managed) {
                try { forwardedArgs = SidebarArguments(config, args); }
                catch { if (requiresManagement) return 126; managed = false; Console.Error.WriteLine("Sidebar control configuration changed; starting ordinary Codex without Meristem."); }
            }
            using (var child=new ProcessTree(real, forwardedArgs)) {
                child.Resume();
                var stderr=Console.OpenStandardError();
                var errorThread=Background(delegate { try { child.Error.CopyTo(stderr); stderr.Flush(); } catch (IOException) {} });
                int result=125;
                var waiter=Background(delegate { result=child.Wait(); child.CloseJob(); });
                if (managed) {
                    var relay=new StdioRelay(child, config, real);
                    ProcessTree control=null;
                    try {
                        var binding=Map(config,"controlHost");
                        if(binding!=null) {
                            // Optional explicitly bound CC-01 owner. Failure never kills the parent App Server.
                            try {
                                string exe=Text(binding,"executable"),file=Text(binding,"configPath"),parentThread=Text(binding,"parentThreadId");
                                if(!Path.IsPathRooted(exe??"")||!Path.IsPathRooted(file??"")||(String.IsNullOrEmpty(parentThread)&&Text(binding,"parentMode")!="verified-start")||Hash(exe)!=Text(binding,"sha256")||Hash(file)!=Text(binding,"configSha256"))throw new InvalidOperationException("control binding identity mismatch");
                                control=new ProcessTree(exe,new[]{"--config",file});control.Resume();
                                var owned=control;
                                relay.ControlStatus=delegate{return new {pid=owned.Pid,exited=owned.IsExited,exitCode=owned.IsExited?(int?)owned.Wait():null};};
                                var brokerConfig=Parse(File.ReadAllText(file,Encoding.UTF8));
                                relay.VerifyWakePeer=delegate(System.Diagnostics.Process peer){return McpPeer.Verify(owned,peer.Id,LocalPipe.Created(peer),brokerConfig,new[]{Text(brokerConfig,"nodeExecutable"),Text(brokerConfig,"entryPoint"),"serve","--config",file});};
                                Background(delegate{try{var buffer=new byte[8192];while(owned.Output.Read(buffer,0,buffer.Length)>0){}}catch{}});
                                Background(delegate{try{var buffer=new byte[8192];while(owned.Error.Read(buffer,0,buffer.Length)>0){}}catch{}});
                                relay.ParentStop=delegate(string thread){if(parentThread!=null&&thread!=parentThread)return;try{byte[] data=Encoding.UTF8.GetBytes(Encode(new {method="parent_stop",threadId=thread})+"\n");lock(owned){owned.Input.Write(data,0,data.Length);owned.Input.Flush();}}catch{owned.CloseJob();}};
                            }catch{if(control!=null){control.Dispose();control=null;}Console.Error.WriteLine("control binding unavailable; parent UI remains available");}
                        }
                        using (var pipe=new LocalPipe(Text(config,"pipeName"), relay)) {
                            relay.Pipe=pipe; pipe.Start(); relay.Run();
                        }
                    }finally{relay.ParentStop=null;if(control!=null)control.Dispose();}
                } else {
                    Background(delegate { try { CopyLive(Console.OpenStandardInput(),child.Input); child.Input.Dispose(); } catch (IOException) {} });
                    CopyLive(child.Output,Console.OpenStandardOutput());
                }
                waiter.Join(); errorThread.Join(2000); return result;
            }
        } catch (Exception e) { Console.Error.WriteLine("relay-start-failed: "+e.GetType().Name+" "+e.Message); return 125; }
    }
}
