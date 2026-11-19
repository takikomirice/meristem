using System;
using System.IO;
using System.Threading;

internal static class CliTerminal {
    private static int Main(string[] args) {
        try {
            if (args.Length<2 || !Path.IsPathRooted(args[0]) || !Console.IsInputRedirected ||
                !Console.IsOutputRedirected || !Console.IsErrorRedirected) throw new ArgumentException();
            var tuiArgs=new string[args.Length-1]; Array.Copy(args,1,tuiArgs,0,tuiArgs.Length);
            using(var tui=new ProcessTree(args[0],tuiArgs,null,true)) {
                Console.Error.WriteLine("{\"pid\":"+tui.Pid+",\"created\":\""+tui.Created+"\"}");
                tui.Resume();
                // The launcher holds this pipe open. Neither commands nor terminal input travel on it.
                var owner=new Thread(delegate() {
                    try { Console.OpenStandardInput().ReadByte(); } catch(IOException) {}
                    finally { tui.CloseJob(); }
                });
                owner.IsBackground=true; owner.Start();
                return tui.Wait();
            }
        } catch(Exception error) { Console.Error.WriteLine("CLI console startup failed: "+error.GetType().Name); return 125; }
    }
}
