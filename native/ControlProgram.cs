using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

// Native-only ingress. The broker has stdio, never a second network/pipe server.
internal sealed class ControlProgram {
    private ProcessTree broker;
    private StreamWriter input;
    private readonly object gate=new object();
    private readonly Dictionary<string,Pending> pending=new Dictionary<string,Pending>();
    private sealed class Pending { internal ManualResetEvent Done=new ManualResetEvent(false); internal string Reply; }
    private volatile bool stopped;
    private string pipeName;
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
        int timeout=Program.Text(request,"method")=="mcp"&&(Program.Text(request,"name")=="create_worker"||Program.Text(request,"name")=="hold_task")?120000:20000;
        try { if(!wait.Done.WaitOne(timeout)||wait.Reply==null)throw new IOException("broker response unknown");return wait.Reply; }
        finally {lock(gate){pending.Remove(id);wait.Done.Dispose();}}
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
                    if(method!="mcp"&&method!="mcp_human_response"&&method!="authorize"&&method!="status"&&method!="stop"&&method!="events"&&method!="close_terminal"&&method!="retire_worker"&&method!="rename_worker"&&method!="lease"&&method!="requests"&&method!="answer_request"
                        &&method!="history_targets"&&method!="worker_history"&&method!="resume_worker_history"){writer.WriteLine("{\"ok\":false,\"error\":\"unsupported_method\"}");continue;}
                    string reply=Call(request,peer);writer.WriteLine(reply);
                    if(method=="lease" && Object.Equals(Program.Parse(reply)["ok"],true)) {
                        try { while(server.ReadByte()!=-1) {} }
                        finally {try{Call(request,peer,"lease_lost");}catch{broker.CloseJob();}}
                    } else {
                        // DisconnectNamedPipe discards unread replies. Let the client consume
                        // the response and close first, with a bounded wait for stalled clients.
                        // ReadAsync owns its completion resources. Closing an APM wait
                        // handle before a timed-out read completes crashes the CLR callback.
                        var consumed=server.ReadAsync(new byte[1],0,1);
                        if(!consumed.Wait(1000)) {
                            server.Dispose();
                            consumed.ContinueWith(task=>{var ignored=task.Exception;},System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted);
                        }
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
