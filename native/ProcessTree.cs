using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Only the suspended child enters this job. Closing the relay closes its job handle.
internal sealed class ProcessTree : IDisposable
{
    internal Stream Input, Output, Error;
    internal bool Assigned;
    private IntPtr job, process, initialThread;
    private readonly object jobGate=new object();
    internal int Pid;
    internal string Created;
    internal IntPtr Handle { get { return process; } }
    [StructLayout(LayoutKind.Sequential)] private struct Security { internal int Length; internal IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit; }
    [StructLayout(LayoutKind.Sequential)] private struct Startup {
        internal int Size; internal IntPtr Reserved, Desktop, Title;
        internal int X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        internal short Show, ReservedSize; internal IntPtr ReservedBytes, In, Out, Err;
    }
    [StructLayout(LayoutKind.Sequential)] private struct StartupEx { internal Startup Info; internal IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { internal IntPtr Process, Thread; internal int Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits {
        internal long ProcessTime, JobTime; internal uint Flags; internal UIntPtr Min, Max;
        internal uint Active; internal UIntPtr Affinity; internal uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Io { internal ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { internal BasicLimits Basic; internal Io Io; internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, int size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,uint length,out uint returned);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CreateProcess(string exe, StringBuilder command, IntPtr processAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateJobObject(IntPtr job,uint code);
    internal bool Contains(IntPtr handle) { lock(jobGate) { bool member; if(job==IntPtr.Zero)return false; Check(IsProcessInJob(handle,job,out member));return member; } }
    internal bool StopAndConfirm(int milliseconds) {
        lock(jobGate) {
            if(job==IntPtr.Zero)return false; // A closed job alone is not absence evidence.
            Check(TerminateJobObject(job,125));
            var deadline=DateTime.UtcNow.AddMilliseconds(milliseconds);
            while(DateTime.UtcNow<deadline) {
                if(ProcessIds().Length==0 && IsExited) { CloseJob();return true; }
                System.Threading.Thread.Sleep(25);
            }
            CloseJob();return false;
        }
    }
    private static void Check(bool result) { if (!result) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    internal static string Quote(string arg) {
        var b = new StringBuilder("\""); int slashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append(c); }
            else { b.Append('\\', slashes); b.Append(c); }
            slashes = 0;
        }
        return b.Append('\\', slashes * 2).Append('"').ToString();
    }
    internal ProcessTree(string executable, string[] args, string workingDirectory=null) {
        IntPtr stdinRead=IntPtr.Zero, stdinWrite=IntPtr.Zero, stdoutRead=IntPtr.Zero, stdoutWrite=IntPtr.Zero, stderrRead=IntPtr.Zero, stderrWrite=IntPtr.Zero;
        IntPtr attributes=IntPtr.Zero, handles=IntPtr.Zero; bool attributesReady=false;
        ProcessInfo info = new ProcessInfo();
        try {
            job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
            var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            var sec = new Security { Length=Marshal.SizeOf(typeof(Security)), Inherit=true };
            Check(CreatePipe(out stdinRead, out stdinWrite, ref sec, 0));
            Check(CreatePipe(out stdoutRead, out stdoutWrite, ref sec, 0));
            Check(CreatePipe(out stderrRead, out stderrWrite, ref sec, 0));
            Check(SetHandleInformation(stdinWrite, 1, 0)); Check(SetHandleInformation(stdoutRead, 1, 0)); Check(SetHandleInformation(stderrRead, 1, 0));
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size)); attributesReady=true;
            handles=Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, stdinRead); Marshal.WriteIntPtr(handles, IntPtr.Size, stdoutWrite); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, stderrWrite);
            Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20002, handles, (IntPtr)(IntPtr.Size*3), IntPtr.Zero, IntPtr.Zero));
            var startup=new StartupEx(); startup.Info.Size=Marshal.SizeOf(startup); startup.Info.Flags=0x100;
            startup.Info.In=stdinRead; startup.Info.Out=stdoutWrite; startup.Info.Err=stderrWrite; startup.Attributes=attributes;
            var command=new StringBuilder(Quote(executable)); foreach (var arg in args) command.Append(' ').Append(Quote(arg));
            Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, workingDirectory, ref startup, out info));
            process=info.Process; Pid=info.Pid;
            long created,exited,kernel,user; Check(GetProcessTimes(process,out created,out exited,out kernel,out user));
            Created=created.ToString(System.Globalization.CultureInfo.InvariantCulture);
            Check(AssignProcessToJobObject(job, process)); bool inJob; Check(IsProcessInJob(process, job, out inJob));
            if (!inJob) throw new InvalidOperationException("child job membership not confirmed");
            Assigned=true;
            Input=new FileStream(new SafeFileHandle(stdinWrite, true), FileAccess.Write, 8192, false); stdinWrite=IntPtr.Zero;
            Output=new FileStream(new SafeFileHandle(stdoutRead, true), FileAccess.Read, 8192, false); stdoutRead=IntPtr.Zero;
            Error=new FileStream(new SafeFileHandle(stderrRead, true), FileAccess.Read, 8192, false); stderrRead=IntPtr.Zero;
            initialThread=info.Thread;info.Thread=IntPtr.Zero;
        } catch { if (process != IntPtr.Zero) { TerminateProcess(process, 125); WaitForSingleObject(process, 5000); } Dispose(); throw; }
        finally {
            if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread);
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes); if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            foreach (var handle in new [] {stdinRead,stdinWrite,stdoutRead,stdoutWrite,stderrRead,stderrWrite}) if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
    internal int Wait() { WaitForSingleObject(process, UInt32.MaxValue); uint code; Check(GetExitCodeProcess(process, out code)); return unchecked((int)code); }
    internal void Resume() {
        lock(jobGate) {
            if(!Assigned||job==IntPtr.Zero||initialThread==IntPtr.Zero)throw new InvalidOperationException("owned suspended child required");
            if(ResumeThread(initialThread)==UInt32.MaxValue)throw new Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(initialThread);initialThread=IntPtr.Zero;
        }
    }
    internal bool WaitForExit(int milliseconds) { return WaitForSingleObject(process, unchecked((uint)milliseconds)) == 0; }
    internal bool IsExited { get { return WaitForExit(0); } }
    internal int[] ProcessIds() {
        lock(jobGate) {
            if(job==IntPtr.Zero)return new int[0];
            int size=8+IntPtr.Size*4096;IntPtr data=Marshal.AllocHGlobal(size);
            try { uint returned;Check(QueryInformationJobObject(job,3,data,(uint)size,out returned));int count=Marshal.ReadInt32(data,4);if(count<0||count>4096)throw new InvalidOperationException("job process count unavailable");var ids=new int[count];for(int i=0;i<count;i++)ids[i]=Marshal.ReadIntPtr(data,8+i*IntPtr.Size).ToInt32();return ids; }
            finally { Marshal.FreeHGlobal(data); }
        }
    }
    internal void CloseJob() { lock(jobGate) { if (job != IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; } } }
    public void Dispose() {
        CloseJob();
        if(initialThread!=IntPtr.Zero){CloseHandle(initialThread);initialThread=IntPtr.Zero;}
        if (Input != null) Input.Dispose(); if (Output != null) Output.Dispose(); if (Error != null) Error.Dispose();
        if (process != IntPtr.Zero) { CloseHandle(process); process=IntPtr.Zero; }
    }
}
