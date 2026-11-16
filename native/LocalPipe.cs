using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;

internal sealed class LocalPipe : IDisposable
{
    private readonly string name;
    private readonly StdioRelay relay;
    private readonly PipeSecurity security;
    private volatile bool stopped;
    private NamedPipeServerStream current;
    private readonly object gate=new object();
    internal string ActualAcl;
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetNamedPipeClientProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint pid);
    internal static Process ClientProcess(NamedPipeServerStream pipe) {
        uint pid;
        if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out pid)) throw new IOException("pipe peer identity unavailable");
        var process=Process.GetProcessById(checked((int)pid));
        // Open and retain the process handle before using its creation identity or job membership.
        var handle=process.Handle;
        return process;
    }
    internal static string Created(Process process) { return process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(System.Globalization.CultureInfo.InvariantCulture); }
    internal LocalPipe(string name, StdioRelay relay) {
        if (String.IsNullOrEmpty(name) || !System.Text.RegularExpressions.Regex.IsMatch(name, "^meristem-cc00-[a-zA-Z0-9-]{1,100}$")) throw new InvalidOperationException("invalid test pipe name");
        this.name=name; this.relay=relay;
        security=CreateSecurity();
    }
    internal static PipeSecurity CreateSecurity() {
        var security=new PipeSecurity(); security.SetAccessRuleProtection(true, false);
        var user=WindowsIdentity.GetCurrent().User;
        security.SetOwner(user);
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        return security;
    }
    private NamedPipeServerStream Create() {
        return new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, security);
    }
    internal void Start() {
        // Failure to bind only disables automation. The UI transport still starts.
        try {
            current=Create(); ActualAcl=current.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Access);
            Console.Error.WriteLine("relay pipe-ready: "+name);
            Program.Background(Serve);
        } catch { relay.Disable("side_channel_bind_failed"); }
    }
    private void Serve() {
        while (!stopped) {
            NamedPipeServerStream pipe;
            lock (gate) pipe=current;
            try {
                pipe.WaitForConnection();
                using (var writer=new StreamWriter(pipe, new UTF8Encoding(false), 4096, true)) {
                    writer.AutoFlush=true;
                    var frame=new MemoryStream(); int b;
                    while (!stopped && (b=pipe.ReadByte()) != -1) {
                        if (frame.Length >= 65536) break;
                        if (b != 10) { frame.WriteByte((byte)b); continue; }
                        object reply;
                        try { using(var peer=ClientProcess(pipe))reply=relay.Call(Program.Parse(new UTF8Encoding(false,true).GetString(frame.ToArray())),peer); }
                        catch { break; } // malformed/closed side channel cannot stop the UI
                        writer.WriteLine(Program.Encode(reply)); frame.SetLength(0);
                    }
                }
            } catch (IOException) {} catch (ObjectDisposedException) {} catch { relay.Disable("side_channel_failed"); }
            finally { if (pipe != null) pipe.Dispose(); }
            lock (gate) {
                if (stopped) break;
                try { current=Create(); } catch { relay.Disable("side_channel_rebind_failed"); break; }
            }
        }
    }
    public void Dispose() { lock (gate) { stopped=true; if (current != null) current.Dispose(); } }
}
