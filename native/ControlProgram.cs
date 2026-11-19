using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

// Native-only ingress. The broker has stdio, never a second network/pipe server.
internal sealed class ControlProgram {
    private ProcessTree broker;
    private StreamWriter input;
    private readonly object gate=new object();
    private readonly Dictionary<string,Pending> pending=new Dictionary<string,Pending>();
    private sealed class Pending { internal ManualResetEvent Done=new ManualResetEvent(false); internal string Reply; }
    private volatile bool stopped;
    private string pipeName, sessionExecutable, sessionSha256, nodeExecutable, cliEntry, terminalHelper, terminalHelperHash;
    private bool ideTerminal, cliSession;
    private Process OpenTerminalSession(Dictionary<string,object> request, Process peer) {
        var identity = Program.Map(request, "terminal");
        if (identity == null || !identity.ContainsKey("pid")) throw new IOException("terminal identity missing");
        var terminal = Process.GetProcessById(Convert.ToInt32(identity["pid"]));
        try {
            var handle = terminal.Handle;
            // VS Code proves the PTY by the owned listener and Terminal.processId.
            if ((!ideTerminal && (LocalPipe.Created(terminal) != Program.Text(identity, "created") || !(cliSession
                ? McpPeer.IsTerminalBridge(peer,terminal,terminalHelper,terminalHelperHash,sessionExecutable)
                : McpPeer.IsDirectParent(peer,terminal))))
                || !String.Equals(terminal.MainModule.FileName, sessionExecutable, StringComparison.OrdinalIgnoreCase)
                || !String.Equals(Program.Hash(sessionExecutable), sessionSha256, StringComparison.OrdinalIgnoreCase)) throw new IOException("terminal identity mismatch");
            return terminal;
        } catch { terminal.Dispose(); throw; }
    }

    [DllImport("iphlpapi.dll")]
    private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);

    // Match both ESTABLISHED loopback rows, including the reverse endpoint and its owner.
    private static bool ConnectedToServer(Process terminal, int serverPid, int port) {
        if (port < 1 || terminal.HasExited) return false;
        int size = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 5, 0);
        if (size < 4 || size > 16*1024*1024) return false;
        var table = Marshal.AllocHGlobal(size);
        try {
            if (GetExtendedTcpTable(table, ref size, false, 2, 5, 0) != 0) return false;
            int rows = Marshal.ReadInt32(table);
            if (rows < 0 || rows > (size-4)/24) return false;
            var clientPorts = new HashSet<int>();
            var serverPeers = new HashSet<int>();
            int wirePort = (port >> 8) | ((port & 255) << 8);
            for (int n=0; n<rows; n++) {
                int pos = 4+n*24;
                if (Marshal.ReadInt32(table,pos) != 5
                    || Marshal.ReadInt32(table,pos+4) != 0x0100007f
                    || Marshal.ReadInt32(table,pos+12) != 0x0100007f) continue;
                int local = Marshal.ReadInt32(table,pos+8) & 65535;
                int remote = Marshal.ReadInt32(table,pos+16) & 65535;
                int pid = Marshal.ReadInt32(table,pos+20);
                if (pid == terminal.Id && remote == wirePort) clientPorts.Add(local);
                if (pid == serverPid && local == wirePort) serverPeers.Add(remote);
            }
            return clientPorts.Overlaps(serverPeers);
        } finally { Marshal.FreeHGlobal(table); }
    }

    private static void HoldLease(NamedPipeServerStream pipe, Process terminal, int serverPid, int port) {
        if (terminal == null) { while (pipe.ReadByte() != -1) {} return; }
        var exited = new System.Threading.Tasks.TaskCompletionSource<bool>();
        terminal.Exited += delegate { exited.TrySetResult(true); };
        terminal.EnableRaisingEvents = true;
        if (terminal.HasExited) return;
        var disconnected = pipe.ReadAsync(new byte[1], 0, 1);
        var ends = new System.Threading.Tasks.Task[]{exited.Task, disconnected};
        while (System.Threading.Tasks.Task.WaitAny(ends, 500) == -1 && ConnectedToServer(terminal, serverPid, port)) {}
        disconnected.ContinueWith(task => { var ignored = task.Exception; }, System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted);
    }
    private static string ReadFrame(Stream stream) {
        using(var bytes=new MemoryStream()) { int b; while((b=stream.ReadByte())!=-1) {if(b==10)return new UTF8Encoding(false,true).GetString(bytes.ToArray());if(bytes.Length>=262144)throw new IOException("frame limit");bytes.WriteByte((byte)b);}return null; }
    }
    private static string ReadPeerFrame(NamedPipeServerStream pipe) {
        var clock=Stopwatch.StartNew();var buffer=new byte[4096];
        using(var frame=new MemoryStream()) {
            while(clock.ElapsedMilliseconds<1500) {
                var read=pipe.ReadAsync(buffer,0,buffer.Length);
                if(!read.Wait(Math.Max(1,1500-(int)clock.ElapsedMilliseconds))){
                    pipe.Dispose();
                    read.ContinueWith(task=>{var ignored=task.Exception;},System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted);
                    throw new IOException("peer frame deadline");
                }
                int count=read.Result;if(count==0)return null;
                for(int i=0;i<count;i++){if(buffer[i]==10)return new UTF8Encoding(false,true).GetString(frame.ToArray());if(frame.Length>=65536)throw new IOException("peer frame limit");frame.WriteByte(buffer[i]);}
            }
        }
        throw new IOException("peer frame deadline");
    }
    internal static void ProtectDirectory(string directory,string repository) {
        string root=Path.GetFullPath(directory), repo=Path.GetFullPath(repository).TrimEnd('\\')+"\\";
        if(root.Equals(repo.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)||root.StartsWith(repo,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("state must remain outside repository");
        // Reject junctions/symlinks before applying ACLs, including any existing ancestor.
        for(var current=new DirectoryInfo(root);current!=null;current=current.Parent) if(current.Exists&&(current.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("reparse state path rejected");
        var security=new DirectorySecurity();security.SetAccessRuleProtection(true,false);
        var user=WindowsIdentity.GetCurrent().User;security.SetOwner(user);
        foreach(var sid in new[]{user,new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null)}) security.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        if(!Directory.Exists(root))Directory.CreateDirectory(root,security);
        else {
            // Never rewrite an arbitrary existing user's directory ACL.
            var actual=Directory.GetAccessControl(root);
            if(!actual.AreAccessRulesProtected)throw new InvalidOperationException("existing state directory is not protected");
            foreach(FileSystemAccessRule rule in actual.GetAccessRules(true,true,typeof(SecurityIdentifier))) if(rule.AccessControlType==AccessControlType.Allow&&!rule.IdentityReference.Equals(user)&&!rule.IdentityReference.Equals(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null)))throw new InvalidOperationException("state directory grants another identity access");
        }
    }
    private string Call(Dictionary<string,object> request,Process peer,string internalMethod=null) {
        string id=Guid.NewGuid().ToString("N");var wait=new Pending();
        lock(gate) {
            if(stopped)throw new IOException("broker unavailable");pending.Add(id,wait);
            input.WriteLine(Program.Encode(new {id=id,request=request,peer=new {pid=peer==null?0:peer.Id,created=peer==null?"":LocalPipe.Created(peer),inBrokerJob=peer!=null&&broker.Contains(peer.Handle)},internalMethod=internalMethod}));
        }
        int timeout=Program.Text(request,"method")=="mcp"&&(Program.Text(request,"name")=="create_worker"||Program.Text(request,"name")=="hold_task"||Program.Text(request,"name")=="save_worker_changes")?120000:Program.Text(request,"method")=="usage"?45000:20000;
        try { if(!wait.Done.WaitOne(timeout)||wait.Reply==null)throw new IOException("broker response unknown");return wait.Reply; }
        finally {lock(gate){pending.Remove(id);wait.Done.Dispose();}}
    }
    // DisconnectNamedPipe discards unread bytes. Wait briefly for the client to consume the reply.
    private static void AwaitClientClose(NamedPipeServerStream pipe) {
        var consumed=pipe.ReadAsync(new byte[1],0,1);
        if(!consumed.Wait(1000)) {
            pipe.Dispose();
            consumed.ContinueWith(task=>{var ignored=task.Exception;},System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted);
        }
    }
    private void Serve(NamedPipeServerStream server,int slot,List<NamedPipeServerStream> servers) {
        while(!stopped) {
            try {
                server.WaitForConnection();
                using(var peer=LocalPipe.ClientProcess(server)) using(var writer=new StreamWriter(server,new UTF8Encoding(false),4096,true)) {
                    writer.AutoFlush=true;
                    // Any descendant of this broker is a worker/worker tool, never a human control client.
                    string line=ReadPeerFrame(server);if(line==null)continue;
                    var request=Program.Parse(line);string method=Program.Text(request,"method");
                    if(method!="mcp"&&broker.Contains(peer.Handle)){writer.WriteLine("{\"ok\":false,\"error\":\"worker_peer_denied\"}");continue;}
                    if(method!="mcp"&&method!="mcp_human_response"&&method!="authorize"&&method!="preview_parent_start"&&method!="start_parent"&&method!="resume_parent"&&method!="status"&&method!="usage"&&method!="stop"&&method!="events"&&method!="close_terminal"&&method!="retire_worker"&&method!="rename_worker"&&method!="lease"&&method!="requests"&&method!="answer_request"&&method!="present_decision"&&method!="answer_decision"
                        &&method!="history_targets"&&method!="worker_history"&&method!="resume_worker_history"){writer.WriteLine("{\"ok\":false,\"error\":\"unsupported_method\"}");continue;}
                    if (cliSession && method!="lease" && method!="mcp" && method!="mcp_human_response" && method!="status" && method!="usage" && method!="events"
                        && !McpPeer.HumanCliLauncher(peer,nodeExecutable,cliEntry)) {
                        writer.WriteLine("{\"ok\":false,\"error\":\"human_cli_origin_unverified\"}");
                        AwaitClientClose(server);
                        continue;
                    }
                    if (method == "lease") {
                        using (var terminal = ideTerminal || Program.Text(request, "sessionKind") == "cli" ? OpenTerminalSession(request, peer) : null) {
                            int port = terminal == null ? 0 : McpPeer.TerminalPort(terminal);
                            if (terminal != null && port < 1) throw new IOException("expected an interactive remote TUI");
                            int serverPid = 0;
                            if (terminal != null) {
                                var proof = Program.Parse(Call(request, peer, "terminal_server"));
                                if (!Object.Equals(proof["ok"], true)) throw new IOException("terminal session owner rejected");
                                object ownsListener;
                                bool launcherEndpoint=proof.TryGetValue("sessionLauncherEndpoint",out ownsListener) && Object.Equals(ownsListener,true);
                                if (launcherEndpoint!=cliSession) throw new IOException("terminal helper binding mismatch");
                                serverPid = launcherEndpoint ? peer.Id : Convert.ToInt32(proof["sessionServerPid"]);
                                if (!ConnectedToServer(terminal, serverPid, port)) throw new IOException("TUI is not connected to this App Server");
                            }
                            string leaseReply = Call(request, peer);
                            var granted=Program.Parse(leaseReply);
                            if (Object.Equals(granted["ok"], true)) {
                                if(cliSession) {
                                    granted["humanControlVerified"]=McpPeer.HumanCliLauncher(peer,nodeExecutable,cliEntry);
                                    leaseReply=Program.Encode(granted);
                                }
                                try {
                                    writer.WriteLine(leaseReply); HoldLease(server, terminal, serverPid, port);
                                }
                                finally { try { Call(request, peer, "lease_lost"); } catch { broker.CloseJob(); } }
                            } else writer.WriteLine(leaseReply);
                        }
                    } else {
                        writer.WriteLine(Call(request, peer));
                        AwaitClientClose(server);
                    }
                }
            } catch(IOException) {} catch(ObjectDisposedException) {if(stopped)return;} catch(Exception e) { Console.Error.WriteLine("control-peer-rejected: "+e.GetType().Name); }
            finally {server.Dispose();}
            lock(gate) {
                if(stopped)return;
                server=CreateServer(slot);servers[slot]=server;
            }
        }
    }
    private NamedPipeServerStream CreateServer(int slot) { return new NamedPipeServerStream(pipeName+"-"+slot,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,LocalPipe.CreateSecurity()); }
    private int Run(string configPath) {
        var config=Program.Parse(File.ReadAllText(configPath,Encoding.UTF8));
        string state=Program.Text(config,"stateDirectory"),repo=Program.Text(config,"repository"),node=Program.Text(config,"nodeExecutable"),entry=Program.Text(config,"entryPoint");
        if(!Path.IsPathRooted(state??"")||!Path.IsPathRooted(repo??"")||!Path.IsPathRooted(node??"")||!Path.IsPathRooted(entry??""))throw new InvalidOperationException("explicit absolute paths required");
        if(!String.Equals(Program.Hash(node),Program.Text(config,"nodeSha256"),StringComparison.OrdinalIgnoreCase)||!String.Equals(Program.Hash(entry),Program.Text(config,"entrySha256"),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("broker executable identity mismatch");
        var runtime = Program.Map(config, "runtime");
        ideTerminal = config.ContainsKey("ideTerminal") && Object.Equals(config["ideTerminal"],true);
        var helper=Program.Map(config,"cliTerminal");
        cliSession=helper!=null;
        terminalHelper=Program.Text(helper,"executable"); terminalHelperHash=Program.Text(helper,"sha256");
        nodeExecutable=node; cliEntry=entry;
        sessionExecutable = Program.Text(runtime, "realExe"); sessionSha256 = Program.Text(runtime, "realSha256");
        ProtectDirectory(state,repo);
        pipeName=Program.Text(config,"pipeName");if(!System.Text.RegularExpressions.Regex.IsMatch(pipeName??"","^meristem-cc01-control-[a-zA-Z0-9-]{1,90}$"))throw new InvalidOperationException("invalid control pipe");
        var servers=new List<NamedPipeServerStream>();
        using(broker=new ProcessTree(node,new[]{entry,"serve","--config",configPath},repo)) {
            input=new StreamWriter(broker.Input,new UTF8Encoding(false),4096,true){AutoFlush=true};
            Program.Background(delegate{try{var buffer=new byte[8192];while(broker.Error.Read(buffer,0,buffer.Length)>0){}}catch{}});
            Program.Background(delegate{try{string line;while((line=ReadFrame(broker.Output))!=null){var message=Program.Parse(line);string id=Program.Text(message,"id");lock(gate){Pending item;if(id!=null&&pending.TryGetValue(id,out item)){item.Reply=Program.Encode(message["result"]);item.Done.Set();}}}}catch{}finally{stopped=true;broker.CloseJob();}});
            broker.Resume();
            // Owner EOF kills the entire broker subtree even if JS is wedged.
            Program.Background(delegate{try{var owner=Console.OpenStandardInput();string line;while((line=ReadFrame(owner))!=null){var message=Program.Parse(line);if(Program.Text(message,"method")=="parent_stop")Call(message,null,"parent_stop");}}catch{}finally{stopped=true;broker.CloseJob();}});
            try {
                for(int i=0;i<16;i++)servers.Add(CreateServer(i));
                for(int i=0;i<16;i++){var captured=servers[i];int slot=i;Program.Background(delegate{Serve(captured,slot,servers);});}
                return broker.Wait();
            }finally{lock(gate){stopped=true;foreach(var server in servers)server.Dispose();}}
        }
    }
    private static int Main(string[] args) {
        try {if(args.Length!=2||args[0]!="--config"||!Path.IsPathRooted(args[1])||!Console.IsInputRedirected)throw new InvalidOperationException("explicit config and owner stdin required");return new ControlProgram().Run(args[1]);}
        catch(Exception e){Console.Error.WriteLine("control-host-failed: "+e.GetType().Name);return 125;}
    }
}
