using System;

internal static class WorkerProgram
{
    private static int Main(string[] args) {
        try {
            if(args.Length==2 && args[0]=="--identity") {
                using(var process=System.Diagnostics.Process.GetProcessById(Int32.Parse(args[1])))Console.WriteLine(LocalPipe.Created(process));
                return 0;
            }
            return WorkerHost.Run(args);
        }
        catch (Exception e) { Console.Error.WriteLine("worker-host-failed: "+e); return 125; }
    }
}
