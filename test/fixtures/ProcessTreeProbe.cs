using System;
using System.Reflection;
internal static class ProcessTreeProbe {
    static void Main(string[] args) {
        using(var child=new ProcessTree(args[0],new[]{"ticker",args[1]},args[2])) {
            Console.WriteLine(child.Assigned?"assigned":"unassigned");
            if(Console.ReadLine()=="resume") {
                typeof(ProcessTree).GetMethod("Resume",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(child,null);
                Console.ReadLine();
            }
        }
    }
}
