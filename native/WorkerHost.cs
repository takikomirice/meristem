using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// CC-00R fixture host. Its public pipe exposes status and stop only; child stdio is never projected.
internal sealed class WorkerHost : IDisposable
{
    private static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=65536, RecursionLimit=16 };
    private readonly string pipeName, cwd, relayPipeName;
    private string agent="fixture",branch="fixture";
    private readonly ProcessTree child;
    private readonly object gate=new object();
    private readonly ManualResetEvent stoppedSignal=new ManualResetEvent(false);
    private readonly List<Dictionary<string,object>> events=new List<Dictionary<string,object>>();
    private long eventSeq;
    private volatile bool stopping, completionCleaned;
    private readonly bool oneShot;
    private int exitCode;
    private readonly Dictionary<string,object> managed;
    private readonly string jobId=Guid.NewGuid().ToString("N");
    private static Dictionary<string,object> Parse(string value) { lock(Json) return Json.Deserialize<Dictionary<string,object>>(value); }
    private static string Text(Dictionary<string,object> value, string key) { object result; return value!=null && value.TryGetValue(key,out result)?result as string:null; }
    private static Thread Background(ThreadStart action) { var thread=new Thread(action); thread.IsBackground=true; thread.Start(); return thread; }
    private static void Forward(Stream source,Stream destination) { var buffer=new byte[8192]; int count; while((count=source.Read(buffer,0,buffer.Length))>0) { destination.Write(buffer,0,count); destination.Flush(); } }
    private void AddEvent(string text) { lock(gate) { events.Add(new Dictionary<string,object>{{"seq",++eventSeq},{"text",text}}); if(events.Count>256) events.RemoveAt(0); } }
    private void OwnerDisconnected() {
        lock(gate) {
            if(stopping)return;
            stopping=true;
            if(oneShot) {
                try { exitCode=child.StopAndConfirm(5000)?86:125; }
                catch { exitCode=125; child.CloseJob(); }
            } else child.CloseJob();
        }
        stoppedSignal.Set();
    }
    private WorkerHost(string mode, string pipeName, string executable, string cwd, string fixtureRoot, string[] args, bool watchBrokerInput, string managedConfig) {
        if (!System.Text.RegularExpressions.Regex.IsMatch(pipeName ?? "", "^meristem-(cc00r|cc01-worker)-[a-zA-Z0-9-]{1,90}$")) throw new InvalidOperationException("invalid fixture pipe");
        if (String.IsNullOrEmpty(cwd) || !Path.IsPathRooted(cwd) || !Directory.Exists(cwd)) throw new InvalidOperationException("absolute existing fixture cwd required");
        if (String.IsNullOrEmpty(executable) || !Path.IsPathRooted(executable) || !File.Exists(executable)) throw new InvalidOperationException("absolute fixture executable required");
        this.pipeName=pipeName; this.cwd=Path.GetFullPath(cwd);
        System.Diagnostics.Process callingShell=null;
        if(mode=="codex-managed") {
            if(!watchBrokerInput || args.Length!=0 || !Path.IsPathRooted(managedConfig??"")) throw new InvalidOperationException("managed configuration and broker channel required");
            managed=Program.Parse(File.ReadAllText(managedConfig,Encoding.UTF8));
            foreach(string key in new[]{"ownerId","ownerEpoch","workerId","attemptId"}) if(!System.Text.RegularExpressions.Regex.IsMatch(Program.Text(managed,key)??"","^[a-zA-Z0-9_-]{1,128}$"))throw new InvalidOperationException("invalid managed identity");
            using(var owner=System.Diagnostics.Process.GetProcessById(Convert.ToInt32(managed["brokerPid"]))) {
                if(LocalPipe.Created(owner)!=Program.Text(managed,"brokerCreated")) throw new InvalidOperationException("broker identity mismatch");
                oneShot=managed.ContainsKey("watchCallingShell") && Object.Equals(managed["watchCallingShell"],true);
                if(oneShot) {
                    if(!McpPeer.IsLauncher(owner) || (callingShell=McpPeer.VerifiedParent(owner))==null) throw new InvalidOperationException("calling process identity unavailable");
                }
            }
            if(!String.Equals(Program.Hash(executable),Program.Text(managed,"realSha256"),StringComparison.OrdinalIgnoreCase) || !String.Equals(Path.GetFullPath(executable),Program.Text(managed,"realExecutable"),StringComparison.OrdinalIgnoreCase) || !String.Equals(this.cwd,Program.Text(managed,"cwd"),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("managed executable identity mismatch");
            agent=Program.Text(managed,"model")+" / "+Program.Text(managed,"effort");
            bool managedProfile=managed.ContainsKey("managedProfile") && Object.Equals(managed["managedProfile"],true);
            var workerArgs = managedProfile ? new[]{
                "-c","forced_login_method=\"chatgpt\"","-c","model_provider=\"openai\"","-c","chatgpt_base_url=\"https://chatgpt.com/backend-api/\"","-c","notify=[]",
                "--disable","hooks","--disable","apps","--disable","plugins","--disable","skill_mcp_dependency_install","--disable","multi_agent","--disable","multi_agent_v2","app-server"
            } : new[]{"app-server"};
            child=new ProcessTree(executable,workerArgs,this.cwd);
        } else if (mode=="fixture") {
            string fixtureExe=Path.GetFullPath(executable), hostDirectory=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            if (!String.Equals(Path.GetFileName(fixtureExe),"MockCodex.exe",StringComparison.OrdinalIgnoreCase) || !String.Equals(Path.GetDirectoryName(fixtureExe),hostDirectory,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("only the adjacent MockCodex fixture is allowed");
            if (args.Length!=2 || (args[0]!="spawn-ticker" && args[0]!="spawn-and-exit") || !Path.IsPathRooted(args[1])) throw new InvalidOperationException("bounded marker fixture arguments required");
            string marker=Path.GetFullPath(args[1]);
            if (!marker.StartsWith(this.cwd.TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("marker must remain inside fixture cwd");
            child=new ProcessTree(fixtureExe, args, this.cwd);
        } else if(mode=="codex-stdio") {
            if(!watchBrokerInput || args.Length!=0 || String.IsNullOrEmpty(fixtureRoot) || !Path.IsPathRooted(fixtureRoot) || !Within(fixtureRoot,this.cwd)) throw new InvalidOperationException("dedicated broker stdio and fixture cwd required");
            var config=Program.Parse(File.ReadAllText(Path.Combine(fixtureRoot,"worker.json"),Encoding.UTF8));
            if(!String.Equals(Path.GetFullPath(executable),Program.Text(config,"realExecutable"),StringComparison.OrdinalIgnoreCase) || !String.Equals(Program.Hash(executable),Program.Text(config,"realSha256"),StringComparison.OrdinalIgnoreCase) || !String.Equals(this.cwd,Program.Text(config,"cwd"),StringComparison.OrdinalIgnoreCase) || !(Program.Text(config,"testProfile")??"").StartsWith("CC-00R-",StringComparison.Ordinal)) throw new InvalidOperationException("dedicated executable and cwd identity mismatch");
            child=new ProcessTree(executable,new[]{"app-server"},this.cwd);
            var requested=Program.Map(config,"requestedAgent");
            agent=(Program.Text(requested,"model")??"unspecified")+" / "+(Program.Text(requested,"effort")??"unspecified")+" (requested)";
        } else if(mode=="codex-relay") {
            if (args.Length!=0 || String.IsNullOrEmpty(fixtureRoot) || !Path.IsPathRooted(fixtureRoot) || !Directory.Exists(fixtureRoot)) throw new InvalidOperationException("real worker needs an explicit fixture root and no arbitrary argv");
            string root=Path.GetFullPath(fixtureRoot), relayExe=Path.GetFullPath(executable);
            if (!Within(root,relayExe) || !String.Equals(Path.GetFileName(relayExe),"CodexRelay.exe",StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("relay executable must be copied inside fixture root");
            if (!Within(root,this.cwd)) throw new InvalidOperationException("worker cwd must remain inside fixture root");
            var config=Program.Parse(File.ReadAllText(relayExe+".json",Encoding.UTF8));
            string real=Program.Text(config,"realExecutable"), expected=Program.Text(config,"realSha256"), profile=Program.Text(config,"testProfile");
            relayPipeName=Program.Text(config,"pipeName");
            if (String.IsNullOrEmpty(real) || !Path.IsPathRooted(real) || !File.Exists(real) || !String.Equals(Program.Hash(real),expected,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("real Codex executable identity mismatch");
            if (String.IsNullOrEmpty(profile) || !profile.StartsWith("CC-00R-",StringComparison.Ordinal)) throw new InvalidOperationException("explicit CC-00R test profile required");
            if (!System.Text.RegularExpressions.Regex.IsMatch(relayPipeName ?? "", "^meristem-cc00-[a-zA-Z0-9-]{1,100}$")) throw new InvalidOperationException("invalid child management pipe");
            bool cwdAllowed=false; var allowed=config["allowedCwds"] as IEnumerable;
            if(allowed!=null) foreach(var item in allowed) if(item is string && String.Equals(Path.GetFullPath((string)item),this.cwd,StringComparison.OrdinalIgnoreCase)) cwdAllowed=true;
            if(!cwdAllowed) throw new InvalidOperationException("worker cwd is outside the relay fixture allowlist");
            child=new ProcessTree(relayExe,new[]{"app-server"},this.cwd);
        } else throw new InvalidOperationException("unknown worker mode");
        if (!child.Assigned) throw new InvalidOperationException("worker job assignment not confirmed");
        if(callingShell!=null) Background(delegate {
            // The verified process handle remains pinned across PID reuse.
            using(callingShell) callingShell.WaitForExit();
            OwnerDisconnected();
        });
        AddEvent(mode=="fixture"?"Worker process entered its dedicated job.":"Dedicated Codex App Server entered its worker job.");
        // Never allow a verbose child to block on stdout/stderr. Protocol and credentials are discarded.
        Drain(child.Error);
        if(mode=="codex-stdio" || managed!=null) {
            // Exactly one broker owns RPC. No UI IDs, management ID rewriting, or synthetic replies.
            Background(delegate {
                try { Forward(Console.OpenStandardInput(),child.Input); } catch {}
                OwnerDisconnected();
            });
            Background(delegate {
                try {
                    var destination=Console.OpenStandardOutput();
                    var buffer=new byte[8192];var frame=new MemoryStream();bool oversized=false;int count;
                    while((count=child.Output.Read(buffer,0,buffer.Length))>0){
                        destination.Write(buffer,0,count);destination.Flush();
                        for(int i=0;i<count;i++){
                            if(buffer[i]==10){if(!oversized)ObserveCodexEvent(Encoding.UTF8.GetString(frame.ToArray()));frame.SetLength(0);oversized=false;}
                            else if(!oversized){if(frame.Length>=1024*1024){frame.SetLength(0);oversized=true;AddEvent("Oversized Codex event omitted.");}else frame.WriteByte(buffer[i]);}
                        }
                    }
                } catch {
                    OwnerDisconnected();
                }
            });
        } else if(watchBrokerInput) Background(delegate {
            try { var input=Console.OpenStandardInput(); while(input.ReadByte()!=-1) {} } catch {}
            lock(gate) { stopping=true; child.CloseJob(); }
            stoppedSignal.Set();
        });
        try { if(!stopping)child.Resume(); } catch { if(!stopping)throw; }
        if(mode=="codex-relay") {
            try { StartCodexSession(); } catch { if(!stopping)throw; }
        } else if(mode!="codex-stdio" && managed==null) Drain(child.Output);
        Background(delegate {
            try {
                int childExit=child.Wait();
                lock(gate) {
                    if(managed==null) {child.CloseJob();completionCleaned=true;}
                    // Preserve an unexpected App Server exit for bounded broker diagnostics.
                    else if(!stopping) {
                        stopping=true;
                        bool empty=child.StopAndConfirm(5000);
                        exitCode=oneShot?(empty?86:125):childExit;
                        stoppedSignal.Set();
                    }
                }
                AddEvent("Worker process exit observed; cleanup confirmation required.");
            } catch { if(managed!=null){if(oneShot)exitCode=125;child.CloseJob();stoppedSignal.Set();} }
        });
    }
    private static bool Within(string root,string path) { string prefix=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar; return Path.GetFullPath(path).StartsWith(prefix,StringComparison.OrdinalIgnoreCase); }
    private void StartCodexSession() {
        var reader=new StreamReader(child.Output,new UTF8Encoding(false,true),false,8192,true);
        var init=new { id="cc00r-host-init", method="initialize", @params=new { clientInfo=new { name="meristem-cc00r-worker-host", version="0.0.0" }, capabilities=new { experimentalApi=true } } };
        byte[] bytes=Encoding.UTF8.GetBytes(Program.Encode(init)+"\n"); child.Input.Write(bytes,0,bytes.Length); child.Input.Flush();
        string reply=reader.ReadLine(); if(String.IsNullOrEmpty(reply) || reply.Length>1024*1024) throw new InvalidOperationException("Codex App Server initialization response unavailable");
        var response=Program.Parse(reply); object id; if(!response.TryGetValue("id",out id) || !Object.Equals(id,"cc00r-host-init") || !response.ContainsKey("result")) throw new InvalidOperationException("Codex App Server initialization rejected");
        bytes=Encoding.UTF8.GetBytes("{\"method\":\"initialized\"}\n"); child.Input.Write(bytes,0,bytes.Length); child.Input.Flush();
        AddEvent("Codex App Server initialized for the dedicated worker.");
        Background(delegate { try { string line; while((line=reader.ReadLine())!=null) ObserveCodexEvent(line); } catch {} });
    }
    private void ObserveCodexEvent(string line) {
        if(line.Length>1024*1024) { AddEvent("Oversized Codex event omitted."); return; }
        try {
            var message=Program.Parse(line); string method=Program.Text(message,"method");
            if(method!=null && message.ContainsKey("id")) AddEvent("Codex server request pending; original approval or response required.");
            if(method=="turn/started" || method=="turn/completed" || method=="thread/status/changed") AddEvent("Codex event: "+method);
        } catch { AddEvent("Malformed Codex event omitted."); }
    }
    private static void Drain(Stream stream) { Background(delegate { try { var buffer=new byte[8192]; while (stream.Read(buffer,0,buffer.Length)>0) {} } catch {} }); }
    private PipeSecurity Security() {
        return LocalPipe.CreateSecurity();
    }
    private NamedPipeServerStream Server(string name) { return new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,Security()); }
    private Dictionary<string,object> Handle(Dictionary<string,object> request) {
        string method=Text(request,"method");
        if(managed!=null) {
            foreach(string key in new[]{"ownerId","ownerEpoch","workerId","attemptId"}) if(Text(request,key)!=Program.Text(managed,key))return new Dictionary<string,object>{{"ok",false},{"error","identity_mismatch"}};
            if(method=="verify_peer") {
                bool owned=false;
                try { owned=McpPeer.Verify(child,Convert.ToInt32(request["peerPid"]),Text(request,"peerCreated"),Program.Map(managed,"mcp")); } catch {}
                return new Dictionary<string,object>{{"ok",true},{"owned",owned}};
            }
            if(method=="status") {
                using(var host=System.Diagnostics.Process.GetCurrentProcess()) using(var process=System.Diagnostics.Process.GetProcessById(child.Pid)) {
                    return new Dictionary<string,object>{{"ok",true},{"hostPid",host.Id},{"hostCreated",LocalPipe.Created(host)},{"pid",child.Pid},{"childCreated",LocalPipe.Created(process)},{"jobId",jobId},{"jobAssigned",child.Assigned},{"jobProcessIds",child.ProcessIds()},{"state",stopping?"stopping":"running"}};
                }
            }
            if(method=="stop") {
                bool exited;lock(gate){stopping=true;exited=child.StopAndConfirm(5000);}
                return new Dictionary<string,object>{{"ok",exited},{"state",exited?"stopped":"unknown"},{"jobEmpty",exited}};
            }
        }
        if (method=="status") return new Dictionary<string,object> { {"ok",true},{"cwd",cwd},{"branch",branch},{"agent",agent},{"pid",child.Pid},{"jobProcessIds",child.ProcessIds()},{"jobAssigned",child.Assigned},{"state",completionCleaned?"completed":(stopping?"stopping":"running")} };
        if (method=="events") {
            object afterValue,limitValue; long after=0; int limit=100;
            if(request.TryGetValue("afterSeq",out afterValue) && afterValue is int) after=(int)afterValue;
            if(request.TryGetValue("limit",out limitValue) && limitValue is int) limit=(int)limitValue;
            if(after<0 || limit<1 || limit>100) return new Dictionary<string,object>{{"ok",false},{"error","invalid_bounds"}};
            lock(gate) {
                var page=new List<Dictionary<string,object>>();foreach(var item in events)if(Convert.ToInt64(item["seq"])>after&&page.Count<limit)page.Add(item);
                long omitted=events.Count==0?0:Math.Max(0,Convert.ToInt64(events[0]["seq"])-after-1);
                return new Dictionary<string,object>{{"ok",true},{"events",page.ToArray()},{"lastSeq",page.Count==0?after:Convert.ToInt64(page[page.Count-1]["seq"])},{"omittedCount",omitted}};
            }
        }
        if (method=="stop") {
            lock(gate) { stopping=true; child.CloseJob(); }
            bool exited=child.WaitForExit(5000);
            if(exited) AddEvent("Worker process exit confirmed after job close.");
            return new Dictionary<string,object> { {"ok",exited},{"state",exited?"stopped":"unknown"},{"jobClosed",true},{"processExited",exited} };
        }
        return new Dictionary<string,object> { {"ok",false},{"error","unsupported_method"} };
    }
    private void ServeOne(NamedPipeServerStream pipe) {
        bool stopRequested=false;
        try {
            if(managed!=null) using(var peer=LocalPipe.ClientProcess(pipe)) {
                if(peer.Id!=Convert.ToInt32(managed["brokerPid"]) || LocalPipe.Created(peer)!=Program.Text(managed,"brokerCreated") || child.Contains(peer.Handle))return;
            }
            using(var writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true)) {
                writer.AutoFlush=true;
                foreach(string line in ReadControlFrames(pipe)) {
                    if(stopping) break;
                    Dictionary<string,object> request;
                    try { request=Parse(line); } catch { writer.WriteLine("{\"ok\":false,\"error\":\"invalid_request\"}"); continue; }
                    var reply=Handle(request);
                    stopRequested=Text(request,"method")=="stop" && stopping;
                    writer.WriteLine(Program.Encode(reply));
                    if(stopRequested) break;
                }
            }
        } finally {
            // Only the stop request owns acknowledgement shutdown. Other display clients
            // cannot dispose its pipe while it is waiting for the child or writing a reply.
            if(stopRequested) {
                try {
                    var pending=pipe.BeginRead(new byte[1],0,1,null,null);
                    if(pending.AsyncWaitHandle.WaitOne(1000)) pipe.EndRead(pending);
                } catch {}
                stoppedSignal.Set();
            }
        }
    }
    private static IEnumerable<string> ReadControlFrames(Stream stream) {
        var bytes=new byte[4096];
        var utf8=new UTF8Encoding(false,true);
        using(var frame=new MemoryStream()) {
            int count;
            while((count=stream.Read(bytes,0,bytes.Length))>0) {
                int start=0;
                while(start<count) {
                    int newline=Array.IndexOf(bytes,(byte)10,start,count-start);
                    int size=(newline<0 ? count : newline)-start;
                    if(frame.Length+size>65536) throw new InvalidDataException("control frame too large");
                    frame.Write(bytes,start,size);
                    if(newline<0) break;
                    yield return utf8.GetString(frame.GetBuffer(),0,(int)frame.Length);
                    frame.SetLength(0);
                    start=newline+1;
                }
            }
        }
    }
    private void ServeLoop(NamedPipeServerStream server) {
        while(!stopping) {
            try { server.WaitForConnection(); ServeOne(server); }
            catch(ObjectDisposedException) { return; }
            catch(IOException) { /* A display client does not own the worker lifetime. */ }
            catch(InvalidDataException) { /* Bounded request rejected without stopping the worker. */ }
            catch(DecoderFallbackException) { /* Reject this client, retaining broker ownership. */ }
            finally { try { if(!stopping && server.IsConnected) server.Disconnect(); } catch(IOException) {} catch(ObjectDisposedException) {} }
        }
    }
    private void Run() {
        var servers=new List<NamedPipeServerStream>(); var threads=new List<Thread>();
        try {
            for(int i=0;i<16;i++) servers.Add(Server(pipeName+"-"+i));
            foreach(var server in servers) { var current=server; threads.Add(Background(delegate { ServeLoop(current); })); }
            stoppedSignal.WaitOne();
        } finally {
            lock(gate) { stopping=true; child.CloseJob(); }
            foreach(var server in servers) server.Dispose();
            var deadline=DateTime.UtcNow.AddSeconds(1);
            foreach(var thread in threads) {
                int remaining=(int)Math.Max(0,(deadline-DateTime.UtcNow).TotalMilliseconds);
                if(remaining==0) break;
                thread.Join(remaining);
            }
        }
    }
    public void Dispose() { lock(gate) { stopping=true; child.CloseJob(); } child.Dispose(); }
    internal static int Run(string[] args) {
        var values=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase); var childArgs=new List<string>();
        for(int i=0;i<args.Length;i++) {
            if(args[i]=="--arg") { if(++i>=args.Length) throw new InvalidOperationException("--arg value required"); childArgs.Add(args[i]); }
            else if(args[i]=="--mode" || args[i]=="--pipe" || args[i]=="--exe" || args[i]=="--cwd" || args[i]=="--fixture-root" || args[i]=="--broker-stdin" || args[i]=="--config") { if(++i>=args.Length || values.ContainsKey(args[i-1])) throw new InvalidOperationException("invalid option"); values.Add(args[i-1],args[i]); }
            else throw new InvalidOperationException("unexpected argument");
        }
        bool watchBrokerInput=values.ContainsKey("--broker-stdin");
        if(watchBrokerInput && (values["--broker-stdin"]!="true" || !Console.IsInputRedirected)) throw new InvalidOperationException("broker stdin requires an explicit redirected owner channel");
        using(var host=new WorkerHost(values.ContainsKey("--mode")?values["--mode"]:"fixture",values.ContainsKey("--pipe")?values["--pipe"]:null,values.ContainsKey("--exe")?values["--exe"]:null,values.ContainsKey("--cwd")?values["--cwd"]:null,values.ContainsKey("--fixture-root")?values["--fixture-root"]:null,childArgs.ToArray(),watchBrokerInput,values.ContainsKey("--config")?values["--config"]:null)) {
            host.Run(); return host.exitCode;
        }
    }
}
