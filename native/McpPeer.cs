using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Job membership alone proves containment, never the authority of an MCP server.
internal static class McpPeer {
    [StructLayout(LayoutKind.Sequential)] private struct BasicInfo { internal IntPtr ExitStatus,Peb,Affinity,Priority,Pid,ParentPid; }
    [StructLayout(LayoutKind.Sequential)] private struct UnicodeString { internal ushort Length,MaximumLength; internal IntPtr Buffer; }
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process,int kind,IntPtr data,int size,out int returned);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool QueryFullProcessImageName(IntPtr process,int flags,StringBuilder name,ref int size);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern IntPtr CommandLineToArgvW(string command,out int count);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    private static bool Same(string a,string b) { return String.Equals(a,b,StringComparison.OrdinalIgnoreCase); }
    private static bool Pinned(string file,string hash) { return Path.IsPathRooted(file??"") && !String.IsNullOrEmpty(hash) && Same(Program.Hash(file),hash); }
    internal static bool IsDirectParent(Process parent, Process child) {
        int size = Marshal.SizeOf(typeof(BasicInfo)), returned;
        IntPtr data = Marshal.AllocHGlobal(size);
        try {
            if (NtQueryInformationProcess(child.Handle, 0, data, size, out returned) != 0 || returned < size) return false;
            var basic = (BasicInfo)Marshal.PtrToStructure(data, typeof(BasicInfo));
            return basic.ParentPid.ToInt64() == parent.Id && parent.StartTime.ToUniversalTime() <= child.StartTime.ToUniversalTime() && !parent.HasExited && !child.HasExited;
        } finally { Marshal.FreeHGlobal(data); }
    }

    internal static Process VerifiedParent(Process process) {
        int size=Marshal.SizeOf(typeof(BasicInfo)), returned;
        var data=Marshal.AllocHGlobal(size);
        try {
            if(NtQueryInformationProcess(process.Handle,0,data,size,out returned)!=0 || returned<size) return null;
            var basic=(BasicInfo)Marshal.PtrToStructure(data,typeof(BasicInfo));
            var parent=Process.GetProcessById(checked((int)basic.ParentPid.ToInt64()));
            try {
                if(IsDirectParent(parent,process) && parent.SessionId==process.SessionId) return parent;
            } catch { parent.Dispose(); throw; }
            parent.Dispose(); return null;
        } finally { Marshal.FreeHGlobal(data); }
    }
    private static bool InteractivePowerShell(Process shell) {
        string system=Environment.GetFolderPath(Environment.SpecialFolder.System);
        string programs=Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string image=shell.MainModule.FileName;
        if(!Same(image,Path.Combine(system,@"WindowsPowerShell\v1.0\powershell.exe")) &&
            !Same(image,Path.Combine(programs,@"PowerShell\7\pwsh.exe"))) return false;
        var args=Arguments(shell);
        if(args==null || args.Length==0)return false;
        for(int i=1;i<args.Length;i++) {
            if(Same(args[i],"-NoLogo") || Same(args[i],"-NoExit") || Same(args[i],"-NoProfile"))continue;
            if(Same(args[i],"-WorkingDirectory") && i+1<args.Length && Path.IsPathRooted(args[++i]))continue;
            return false;
        }
        return true;
    }
    private static bool WindowsTerminal(Process terminal) {
        string exe=terminal.MainModule.FileName;
        var package=Directory.GetParent(exe);
        return Same(Path.GetFileName(exe),"WindowsTerminal.exe") && package!=null && package.Parent!=null
            && Same(package.Parent.FullName,Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"WindowsApps"))
            && System.Text.RegularExpressions.Regex.IsMatch(package.Name,@"^Microsoft\.WindowsTerminal(?:Preview)?_[0-9.]+_(?:x64|arm64)__8wekyb3d8bbwe$",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }
    private static string[] Arguments(Process process) {
        var data=Marshal.AllocHGlobal(65536);
        try {return ReadArguments(process.Handle,data);}finally{Marshal.FreeHGlobal(data);}
    }
    internal static bool IsTerminalBridge(Process launcher,Process terminal,string helper,string helperHash,string tui) {
        try {
            using(var parent=VerifiedParent(terminal)) {
                if(parent==null || !IsDirectParent(launcher,parent) || !Same(parent.MainModule.FileName,helper) || !Pinned(helper,helperHash))
                    return false;
                var args=Arguments(parent); var childArgs=Arguments(terminal);
                if(args==null || childArgs==null || args.Length!=childArgs.Length+1 || !Same(args[1],tui))return false;
                for(int i=1;i<childArgs.Length;i++)if(args[i+1]!=childArgs[i])return false;
                return true;
            }
        } catch {return false;}
    }
    internal static bool HumanCliLauncher(Process peer,string node,string entry) {
        try {
            if(!Same(peer.MainModule.FileName,node) || peer.SessionId==0)return false;
            // The native control process is a child of this run's relay. Other approved terminals
            // can have the same node path and arguments, but cannot act for this relay.
            using(var control=Process.GetCurrentProcess())
            using(var relay=VerifiedParent(control)) {
                if(relay==null || !IsDirectParent(peer,relay))return false;
            }
            var args=Arguments(peer);
            if(args==null || args.Length!=4 || !Same(args[1],entry) || args[2]!="terminal" ||
                (args[3]!="start" && args[3]!="resume")) return false;
            string explorer=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"explorer.exe");
            using(var shell=VerifiedParent(peer)) {
                if(shell==null || !InteractivePowerShell(shell))return false;
                using(var owner=VerifiedParent(shell)) {
                    if(owner==null)return false;
                    if(Same(owner.MainModule.FileName,explorer))return true;
                    if(!WindowsTerminal(owner))return false;
                    using(var desktop=VerifiedParent(owner))return desktop!=null && Same(desktop.MainModule.FileName,explorer);
                }
            }
        } catch {return false;}
    }
    internal static bool IsLauncher(Process peer) {
        using (var relay = Process.GetCurrentProcess()) return IsDirectParent(peer, relay);
    }
    private static string[] ReadArguments(IntPtr handle, IntPtr data) {
        int returned;
        if (NtQueryInformationProcess(handle, 60, data, 65536, out returned) != 0) return null;
        var command = (UnicodeString)Marshal.PtrToStructure(data, typeof(UnicodeString));
        long offset = command.Buffer.ToInt64() - data.ToInt64();
        if (command.Length == 0 || command.Length % 2 != 0 || offset < Marshal.SizeOf(typeof(UnicodeString)) || offset + command.Length > Math.Min(returned, 65536)) return null;
        int count;
        IntPtr argv = CommandLineToArgvW(Marshal.PtrToStringUni(command.Buffer, command.Length / 2), out count);
        if (argv == IntPtr.Zero) return null;
        try {
            var args = new string[count];
            for (int i=0; i<count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i*IntPtr.Size));
            return args;
        } finally { LocalFree(argv); }
    }

    internal static int TerminalPort(Process terminal) {
        var data = Marshal.AllocHGlobal(65536);
        try {
            var args = ReadArguments(terminal.Handle, data);
            if (args == null) return 0;
            Uri endpoint = null;
            string tokenVariable = null;
            for (int i=1; i<args.Length; i++) {
                string arg = args[i];
                if (arg == "--no-alt-screen") continue;
                if (++i >= args.Length) return 0;
                if (arg == "--remote" && endpoint == null) {
                    if (!Uri.TryCreate(args[i], UriKind.Absolute, out endpoint) || endpoint.Scheme != "ws" || endpoint.Host != "127.0.0.1") return 0;
                } else if (arg == "--remote-auth-token-env" && tokenVariable == null) tokenVariable = args[i];
                else if (arg == "-C" || arg == "--cd") { if (!Path.IsPathRooted(args[i])) return 0; }
                else if (arg != "resume" || i != args.Length-1) return 0;
            }
            return endpoint == null || String.IsNullOrEmpty(tokenVariable) ? 0 : endpoint.Port;
        } finally { Marshal.FreeHGlobal(data); }
    }

    internal static bool Verify(ProcessTree parent,int pid,string created,Dictionary<string,object> pins,string[] arguments=null) {
        try {
            if(pins==null || parent.IsExited) return false;
            string node=Program.Text(pins,"nodeExecutable"),entry=Program.Text(pins,"entryPoint"),pipe=Program.Text(pins,"pipeName");
            if((arguments==null&&String.IsNullOrEmpty(pipe))||!Pinned(node,Program.Text(pins,"nodeSha256"))||!Pinned(entry,Program.Text(pins,"entrySha256"))) return false;
            // Retain both handles throughout verification. A recycled PID cannot replace either process.
            using(var peer=Process.GetProcessById(pid)) {
                IntPtr handle=peer.Handle;long parentCreated,exited,kernel,user;
                if(!GetProcessTimes(parent.Handle,out parentCreated,out exited,out kernel,out user)||parentCreated.ToString(System.Globalization.CultureInfo.InvariantCulture)!=parent.Created || peer.HasExited || LocalPipe.Created(peer)!=created || !parent.Contains(handle)) return false;
                IntPtr data=Marshal.AllocHGlobal(65536);
                try {
                    int returned;
                    if(NtQueryInformationProcess(handle,0,data,Marshal.SizeOf(typeof(BasicInfo)),out returned)!=0) return false;
                    var basic=(BasicInfo)Marshal.PtrToStructure(data,typeof(BasicInfo));
                    if(basic.Pid.ToInt64()!=pid || basic.ParentPid.ToInt64()!=parent.Pid || peer.StartTime.ToUniversalTime().ToFileTimeUtc()<parentCreated) return false;
                    var image=new StringBuilder(32768);int size=image.Capacity;
                    if(!QueryFullProcessImageName(handle,0,image,ref size)||!Same(Path.GetFullPath(image.ToString()),Path.GetFullPath(node))) return false;
                    var actual = ReadArguments(handle, data);
                    var expected = arguments ?? new[]{node,entry,"--pipe",pipe};
                    if(actual==null || actual.Length!=expected.Length)return false;
                    for(int i=0;i<actual.Length;i++)if(!Same(actual[i],expected[i]))return false;
                    return !parent.IsExited && !peer.HasExited && LocalPipe.Created(peer)==created;
                } finally {Marshal.FreeHGlobal(data);}
            }
        } catch {return false;} // Missing OS proof or pins never grants identity.
    }
}
