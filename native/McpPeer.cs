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
                    if(NtQueryInformationProcess(handle,60,data,65536,out returned)!=0) return false;
                    var command=(UnicodeString)Marshal.PtrToStructure(data,typeof(UnicodeString));
                    long offset=command.Buffer.ToInt64()-data.ToInt64();
                    if(command.Length==0 || command.Length%2!=0 || offset<Marshal.SizeOf(typeof(UnicodeString)) || offset+command.Length>Math.Min(returned,65536)) return false;
                    int count;IntPtr argv=CommandLineToArgvW(Marshal.PtrToStringUni(command.Buffer,command.Length/2),out count);
                    if(argv==IntPtr.Zero)return false;
                    try {
                        var expected=arguments??new[]{node,entry,"--pipe",pipe};
                        if(count!=expected.Length)return false;
                        for(int i=0;i<count;i++)if(!Same(Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv,i*IntPtr.Size)),expected[i]))return false;
                    } finally {LocalFree(argv);}
                    return !parent.IsExited && !peer.HasExited && LocalPipe.Created(peer)==created;
                } finally {Marshal.FreeHGlobal(data);}
            }
        } catch {return false;} // Missing OS proof or pins never grants identity.
    }
}
