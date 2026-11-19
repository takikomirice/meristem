using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class MockCodex {
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=10*1024*1024 };
    static void Write(object o) { Console.WriteLine(Json.Serialize(o)); }
    static string Quote(string value) { return "\""+value.Replace("\"","\\\"")+"\""; }
    static void Forward(Stream source,Stream destination) {var bytes=new byte[8192];int count;while((count=source.Read(bytes,0,bytes.Length))>0){destination.Write(bytes,0,count);destination.Flush();}}
    static void RunMcp(string executable,string helper,string file) {
        var config=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
        bool bridge=!config.ContainsKey("direct")&&!config.ContainsKey("descendant");
        config["bridged"]=bridge;File.WriteAllText(file,Json.Serialize(config));
        var info=new ProcessStartInfo(executable,Quote(helper)+" "+Quote(file)){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        Process server=null;
        try {
            if(bridge)server=Process.Start(new ProcessStartInfo(executable,Quote((string)config["entryPoint"])+" --pipe "+Quote((string)config["pipeName"])){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true});
            using(var client=Process.Start(info)) {
                if(server!=null) {
                    var captured=server;
                    var forward=new Thread(delegate(){try{Forward(client.StandardOutput.BaseStream,captured.StandardInput.BaseStream);}catch{}finally{try{captured.StandardInput.Close();}catch{}}});forward.IsBackground=true;forward.Start();
                    var reverse=new Thread(delegate(){try{Forward(captured.StandardOutput.BaseStream,client.StandardInput.BaseStream);}catch{}});reverse.IsBackground=true;reverse.Start();
                } else client.StandardOutput.ReadToEnd();
                string error=client.StandardError.ReadToEnd();
                if(!client.WaitForExit(10000)||client.ExitCode!=0)throw new Exception("MCP fixture failed: "+error);
            }
        } finally {if(server!=null){try{if(!server.WaitForExit(1000))server.Kill();}catch{}server.Dispose();}}
    }
    static int Main(string[] args) {
        if (args.Length == 4 && args[0] == "--remote" && args[2] == "--remote-auth-token-env") {
            var uri = new Uri(args[1]);
            using (var connection = new System.Net.Sockets.TcpClient("127.0.0.1", uri.Port)) {
                Console.WriteLine("connected"); Console.Out.Flush(); Console.ReadLine();
            }
            return 0;
        }
        Console.OutputEncoding=new UTF8Encoding(false); Console.InputEncoding=new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("mock-codex 0"); return 0; }
        if (args.Length > 0 && args[0] == "ticker") {
            while (true) { File.AppendAllText(args[1], "."); Thread.Sleep(30); }
        }
        if (args.Length > 0 && args[0] == "spawn-ticker") {
            var childInfo=new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, "ticker \""+args[1]+"\"");
            childInfo.UseShellExecute=false; childInfo.CreateNoWindow=true; Process.Start(childInfo);
            while(true) Thread.Sleep(1000);
        }
        if (args.Length > 0 && args[0] == "spawn-and-exit") {
            var childInfo=new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, "ticker \""+args[1]+"\"");
            childInfo.UseShellExecute=false; childInfo.CreateNoWindow=true; Process.Start(childInfo);
            for(int i=0;i<100 && !File.Exists(args[1]);i++) Thread.Sleep(10);
            return 0;
        }
        if (Array.IndexOf(args,"app-server") < 0) {
            Write(new { argv=args }); Console.Error.WriteLine("mock-stderr");
            Console.OpenStandardInput().CopyTo(Console.OpenStandardOutput()); return 23;
        }
        string line;object approvalThread=null;string approvalTurn=null;bool approvalCompleteFirst=false;Dictionary<string,object> threadConfig=null;string compatibilityThread=null,reviewCall=null;
        while ((line=Console.ReadLine()) != null) {
            var m=Json.Deserialize<Dictionary<string,object>>(line);
            if (!m.ContainsKey("id")) continue;
            if(!m.ContainsKey("method")) {
                if(Object.Equals(m["id"],"human-approval")&&approvalThread!=null) {
                    File.WriteAllText(Path.Combine(Directory.GetCurrentDirectory(),"approval-response.json"),line);
                    if(approvalCompleteFirst)Write(new {method="turn/completed",@params=new {threadId=approvalThread,turn=new {id=approvalTurn,status="completed"}}});
                    Write(new {method="serverRequest/resolved",@params=new {threadId=approvalThread,requestId="human-approval"}});
                    if(!approvalCompleteFirst)Write(new {method="turn/completed",@params=new {threadId=approvalThread,turn=new {id=approvalTurn,status="completed"}}});
                    approvalThread=null;approvalTurn=null;
                }
                continue;
            }
            var p=m.ContainsKey("params") ? m["params"] as Dictionary<string,object> : new Dictionary<string,object>();
            object result=new {};
            if(File.Exists("history-fixture.json")) {
                string method=(string)m["method"];
                File.AppendAllText("history-fixture-methods.txt",method+Environment.NewLine);
                if(method=="thread/read"||method=="thread/turns/list") {
                    var saved=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText("history-fixture.json"));
                    if(!Object.Equals(p["threadId"],saved["threadId"])) Write(new {id=m["id"],error=new {code=-32602,message="fixture thread absent"}});
                    else Write(new {id=m["id"],result=saved[method]});
                    continue;
                }
            }
            // Opt-in protocol fixture for MC-02. Never evidence of real Codex/UI behavior.
            if(File.Exists("compatibility-fixture.json")) {
                string scenario=(string)Json.Deserialize<Dictionary<string,object>>(File.ReadAllText("compatibility-fixture.json"))["scenario"];
                string method=(string)m["method"];
                if(method=="thread/inject_items") {
                    if(scenario=="inject_rejected") {Write(new {id=m["id"],error=new {code=-32600,message="private-error"}});continue;}
                    var items=p["items"] as System.Collections.ArrayList;
                    var call=items[items.Count-1] as Dictionary<string,object>;reviewCall=(string)call["call_id"];
                    Write(new {id=m["id"],result=new {}});continue;
                }
                if(method=="thread/guardianReview") {
                    if(scenario=="guardian_rejected") {Write(new {id=m["id"],error=new {code=-32600,message="private-error"}});continue;}
                    Write(new {id=m["id"],result=new {callId=reviewCall,assessment=new {outcome=reviewCall.Contains("deny")?"deny":"allow",rationale="private-rationale"}}});continue;
                }
                if(method=="model/list"&&scenario=="model_paged"&&(!p.ContainsKey("cursor")||p["cursor"]==null)) {
                    Write(new {id=m["id"],result=new {data=new object[0],nextCursor="next"}});continue;
                }
                if(method=="account/read") { Write(new {id=m["id"],result=new {account=scenario=="account_missing"?null:new {type="chatgpt",email="private-account"},requiresOpenaiAuth=true}});continue; }
                if(method=="turn/start") {
                    File.AppendAllText("probe-turn-count.txt","1");
                    if(scenario=="turn_rejected")Write(new {id=m["id"],error=new {code=-32600,message="private-error"}});
                    else {
                        Write(new {method="turn/completed",@params=new {threadId=p["threadId"],turn=new {id="mc02-turn",status="completed"}}});
                        Write(new {id=m["id"],result=new {turn=new {id="mc02-turn"}}});
                    }
                    continue;
                }
                if(method=="thread/start"||method=="thread/resume"||method=="thread/read") {
                    if(method=="thread/start"&&scenario=="reviewer_rejected"||method=="thread/read"&&scenario=="read_rejected") {
                        Write(new {id=m["id"],error=new {code=-32600,message="private-error"}});continue;
                    }
                    if(method=="thread/start")compatibilityThread=Guid.NewGuid().ToString();
                    string id=method=="thread/resume"&&scenario=="resume_mismatch"?"wrong-thread":compatibilityThread;
                    var thread=new {id=id,cwd=Directory.GetCurrentDirectory(),parentThreadId=(string)null,modelProvider="mock",status=new {type="idle"},turns=new object[0],preview="private-history"};
                    Write(new {id=m["id"],result=new {thread=thread,model="mock",approvalsReviewer=scenario=="reviewer_mismatch"?"user":"auto_review",activePermissionProfile=new {id=scenario=="profile_mismatch"?":workspace":"meristem-managed"}}});continue;
                }
            }
            string expectedSandbox=Path.Combine(Directory.GetCurrentDirectory(),"expected-sandbox.txt");
            if(File.Exists(expectedSandbox)&&((string)m["method"]=="thread/start"||(string)m["method"]=="thread/resume")) {
                var requestedConfig=p.ContainsKey("config")?p["config"] as Dictionary<string,object>:null;
                if(requestedConfig==null||!requestedConfig.ContainsKey("windows.sandbox")||!Object.Equals(requestedConfig["windows.sandbox"],File.ReadAllText(expectedSandbox))) {
                    Write(new {id=m["id"],error=new {code=-32602,message="expected explicit Windows sandbox"}});continue;
                }
            }
            switch ((string)m["method"]) {
                case "account/read":
                    result=new {account=new {type="chatgpt",email="fixture@example.invalid",workspaceName="fixture"},userId="fixture-user"};break;
                case "account/rateLimits/read":
                    result=new {accountId="fixture-billing",ordinaryUsageAllowed=true,rateLimits=new {limitId="codex",primary=new {usedPercent=80,windowDurationMins=300,resetsAt=(object)null},secondary=(object)null}};break;
                case "initialize":
                    if (Environment.GetEnvironmentVariable("CC00_MOCK_INIT") == "exit") return 17;
                    if (Environment.GetEnvironmentVariable("CC00_MOCK_INIT") == "silent") {
                        string marker=Environment.GetEnvironmentVariable("CC00_MOCK_INIT_MARKER");
                        if(marker!=null && String.Equals(Path.GetDirectoryName(Path.GetFullPath(marker)),Directory.GetCurrentDirectory(),StringComparison.OrdinalIgnoreCase)) File.WriteAllText(marker,Process.GetCurrentProcess().Id.ToString());
                        Thread.Sleep(Timeout.Infinite);
                    }
                    result=new { userAgent="mock-codex 0" }; break;
                case "model/list":
                    if(p.ContainsKey("cursor") && Object.Equals(p["cursor"],"hold-for-collision")) Thread.Sleep(400);
                    if(p.ContainsKey("cursor") && Object.Equals(p["cursor"],"changed-envelope")) { Console.WriteLine("{\"result\":{\"payload\":\"management-private-payload\"},\"id\":"+Json.Serialize(m["id"])); return 0; }
                    if(File.Exists("model-catalog.json")) {
                        var pages=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText("model-catalog.json"));
                        result=pages[p.ContainsKey("cursor") && p["cursor"]!=null ? (string)p["cursor"] : "first"]; break;
                    }
                    result=new { data=new [] {new { id="mock", model="mock", supportedReasoningEfforts=new [] {new {reasoningEffort="low", description="mock"}}}}, nextCursor=(string)null }; break;
                case "echo": result=p; break;
                case "mcpServerStatus/list":
                    if(!p.ContainsKey("serverName")&&File.Exists("review-mcp-inventory.json")) {
                        result=Json.DeserializeObject(File.ReadAllText("review-mcp-inventory.json"));
                        if(File.Exists("review-mcp-next.json")) File.Replace("review-mcp-next.json","review-mcp-inventory.json",null);
                    }
                    else {
                        var server=new {name="meristem",runtimeStatus="connected",httpOrigin=(string)null,pluginId=(string)null,toolsError=(string)null,tools=new {start_run=new {},report=new {}}};
                        bool hasServer=p.ContainsKey("serverName")||threadConfig!=null&&threadConfig.ContainsKey("mcp_servers.meristem");
                        result=new {data=hasServer?new object[]{server}:new object[0],nextCursor=(string)null};
                    }
                    break;
                case "fixture/mcp": {
                    RunMcp((string)p["executable"],(string)p["helper"],(string)p["file"]);break;
                }
                case "fixture/terminal-listener": {
                    var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
                    listener.Start();
                    var keepAlive = new Thread(delegate() {
                        using (var connection = listener.AcceptTcpClient()) { connection.GetStream().ReadByte(); }
                        listener.Stop();
                    });
                    keepAlive.IsBackground = true; keepAlive.Start();
                    result = new { port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port }; break;
                }
                case "fixture/events":
                    for(int i=0;i<300;i++)Write(new {method="turn/started",@params=new {secret="Bearer must-never-appear-in-terminal"}});
                    break;
                case "large": result=new { length=8*1024*1024+17, payload=new string('x',8*1024*1024+17) }; break;
                case "thread/read":
                    if (!p.ContainsKey("includeTurns")) {
                        Console.WriteLine("{\"id\":"+Json.Serialize(m["id"])+",\"result\":{\"payload\":\"management-private-payload\""); return 0;
                    }
                    if (p.ContainsKey("includeTurns") && Object.Equals(p["includeTurns"],false)) {
                        Console.Write("{\"id\":"+Json.Serialize(m["id"])+",\"result\":{\"payload\":\"management-private-payload\""); return 0;
                    }
                    result=new { payload="management-private-payload"+new string('x',8*1024*1024+17) }; break;
                case "thread/start":
                    threadConfig=p.ContainsKey("config")?(Dictionary<string,object>)p["config"]:null;
                    bool readOnly=Object.Equals(p.ContainsKey("permissions")?p["permissions"]:null,"meristem-read-only");
                    if(readOnly) {
                        var profile=threadConfig==null||!threadConfig.ContainsKey("permissions.meristem-read-only")?null:threadConfig["permissions.meristem-read-only"] as Dictionary<string,object>;
                        var filesystem=profile==null||!profile.ContainsKey("filesystem")?null:profile["filesystem"] as Dictionary<string,object>;
                        if(filesystem==null||filesystem.Count!=1||!filesystem.ContainsValue("deny")||!Object.Equals(profile["extends"],":read-only")||
                           !Object.Equals(threadConfig["default_permissions"],"meristem-read-only")) {
                            Write(new {id=m["id"],error=new {code=-32602,message="invalid read-only profile"}});continue;
                        }
                        foreach(string feature in new[]{"request_permissions_tool","exec_permission_approvals","plugins","apps","hooks","skill_mcp_dependency_install"})
                            if(!threadConfig.ContainsKey("features."+feature)||!Object.Equals(threadConfig["features."+feature],false)) throw new Exception("read-only feature must be disabled");
                    }
                    var settings=new Dictionary<string,object> {
                        {"thread",new { id=Guid.NewGuid().ToString(), parentThreadId=(string)null, environments=new[]{new{environmentId="local",cwd=p["cwd"]}}, cwd=p["cwd"], modelProvider="mock", status=new { type="idle" } }},
                        {"cwd",p["cwd"]},{"runtimeWorkspaceRoots",p.ContainsKey("runtimeWorkspaceRoots")?p["runtimeWorkspaceRoots"]:new object[]{p["cwd"]}},{"model",p.ContainsKey("model")?p["model"]:"mock"},
                        {"reasoningEffort",threadConfig!=null&&threadConfig.ContainsKey("model_reasoning_effort")?threadConfig["model_reasoning_effort"]:"low"},
                        {"approvalsReviewer",p.ContainsKey("approvalsReviewer")?p["approvalsReviewer"]:"user"},
                        {"approvalPolicy",p.ContainsKey("approvalPolicy")?p["approvalPolicy"]:"on-request"},
                        {"activePermissionProfile",new {id=p.ContainsKey("permissions")?p["permissions"]:":workspace",extends=readOnly?":read-only":":workspace"}},
                        {"sandbox",new {type=readOnly?"readOnly":"workspaceWrite",networkAccess=false}}
                    };
                    if(File.Exists("mc07-ack.json")) foreach(var pair in Json.Deserialize<Dictionary<string,object>>(File.ReadAllText("mc07-ack.json")))settings[pair.Key]=pair.Value;
                    result=settings; break;
                case "thread/resume": result=new { thread=new { id=p["threadId"], parentThreadId=(string)null, cwd=Directory.GetCurrentDirectory(), modelProvider="mock", status=new { type="idle" } }, model="mock", reasoningEffort="low" }; break;
                case "turn/start":
                    if(File.Exists("observed-settings.json")) {
                        var observed=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText("observed-settings.json"));
                        if(!observed.ContainsKey("threadId")) observed["threadId"]=p["threadId"];
                        Write(new {method="thread/settings/updated",@params=observed});
                    }
                    if(Json.Serialize(p).Contains("fixture-exit-before-ack")) return 23;
                    if(Json.Serialize(p).Contains("fixture-auth-error")) { Write(new { id=m["id"], error=new {code=-32000,message="Bearer secret-must-not-persist",data=new {codexErrorInfo="unauthorized"}} });continue; }
                    if(Json.Serialize(p).Contains("fixture-limit-error")) { Write(new { id=m["id"], error=new {code=-32000,message="private-limit-details",data=new {codexErrorInfo="usageLimitExceeded"}} });continue; }
                    if(Json.Serialize(p).Contains("fixture-start-marker")) {
                        var ticker=new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location,"ticker \""+Path.Combine(Directory.GetCurrentDirectory(),"worker.marker")+"\"");
                        ticker.UseShellExecute=false;ticker.CreateNoWindow=true;Process.Start(ticker);
                        string probe=Path.Combine(Directory.GetCurrentDirectory(),"peer-pipe.txt");
                        if(File.Exists(probe)) {
                            using(var peer=new System.IO.Pipes.NamedPipeClientStream(".",File.ReadAllText(probe).Trim()+"-14",System.IO.Pipes.PipeDirection.InOut)) {
                                peer.Connect(3000);
                                byte[] request=Encoding.UTF8.GetBytes("{\"method\":\"stop\"}\n");peer.Write(request,0,request.Length);peer.Flush();
                                using(var reader=new StreamReader(peer)) File.WriteAllText(Path.Combine(Directory.GetCurrentDirectory(),"peer-result.json"),reader.ReadLine());
                            }
                        }
                    }
                    string turnId=Guid.NewGuid().ToString();
                    Write(new {method="turn/started",@params=new {threadId=p["threadId"],turn=new {id=turnId,status="inProgress"}}});
                    if(File.Exists(Path.Combine(Directory.GetCurrentDirectory(),"display-activity"))) {
                        var threadId=p["threadId"];
                        for(int index=0;index<320;index++) Write(new {method="item/started",@params=new {threadId,turnId,item=new {type="commandExecution",command="fixture-private",aggregatedOutput="api_key=fixture-private"}}});
                        Write(new {method="item/completed",@params=new {threadId,turnId,item=new {type="commandExecution",command="npm test -- fixture-private",exitCode=0,aggregatedOutput="claimed-test-count"}}});
                        Write(new {method="item/completed",@params=new {threadId,turnId,item=new {type="fileChange",changes=new[]{new {path="fixture-private",diff="api_key=fixture-private"}}}}});
                        Write(new {method="item/completed",@params=new {threadId,turnId="old-turn",item=new {type="commandExecution",command="fixture-private"}}});
                        Write(new {method="item/completed",@params=new {threadId,turnId,item=new {type="reasoning",summary=new[]{"fixture-private"},content=new[]{"fixture-private"}}}});
                        Write(new {method="item/completed",@params=new {threadId,turnId,item=new {type="agentMessage",phase="commentary",text="api_key=fixture-private"}}});
                    }
                    if(Json.Serialize(p).Contains("fixture-parallel-completion")) {
                        File.WriteAllText(Path.Combine(Directory.GetCurrentDirectory(),"active-turn.txt"),turnId);
                        var parallelThread=p["threadId"];var parallelTurn=turnId;
                        ThreadPool.QueueUserWorkItem(delegate {
                            while(!File.Exists(Path.Combine(Directory.GetCurrentDirectory(),"complete-turn")))Thread.Sleep(50);
                            Write(new {method="turn/completed",@params=new {threadId=parallelThread,turn=new {id=parallelTurn,status="completed"}}});
                        });
                    }
                    if(Json.Serialize(p).Contains("fixture-natural-question")) {
                        File.WriteAllText(Path.Combine(Directory.GetCurrentDirectory(),"active-turn.txt"),turnId);
                        var questionThread=p["threadId"];var questionTurn=turnId;
                        ThreadPool.QueueUserWorkItem(delegate {
                            for(int i=0;i<200&&!File.Exists(Path.Combine(Directory.GetCurrentDirectory(),"complete-turn"));i++)Thread.Sleep(20);
                            Write(new {method="turn/completed",@params=new {threadId=questionThread,turn=new {id=questionTurn,status="completed"}}});
                        });
                    }
                    if(Json.Serialize(p).Contains("fixture-git-")) {
                        if(threadConfig==null||!threadConfig.ContainsKey("features.request_permissions_tool")||!Object.Equals(threadConfig["features.request_permissions_tool"],true)||!threadConfig.ContainsKey("features.exec_permission_approvals")||!Object.Equals(threadConfig["features.exec_permission_approvals"],true)) {
                            Write(new {id="human-approval",method="fixture/gitApprovalToolsDisabled",@params=new {threadId=p["threadId"],turnId=turnId}});result=new {turn=new {id=turnId}};break;
                        }
                        approvalThread=p["threadId"];approvalTurn=turnId;
                        string cwd=Directory.GetCurrentDirectory(),root=File.ReadAllText(Path.Combine(cwd,"git-approval-root.txt"));
                        var permissions=new {network=(object)null,fileSystem=new {read=(object)null,write=new[]{root}}};
                        if(Json.Serialize(p).Contains("fixture-git-command")) Write(new {id="human-approval",method="item/commandExecution/requestApproval",@params=new {kind="command",threadId=approvalThread,turnId=turnId,itemId="git-item",startedAtMs=1,environmentId="local",cwd=cwd,command="git commit -m fixture",additionalPermissions=permissions,availableDecisions=new[]{"accept","decline","cancel"}}});
                        else Write(new {id="human-approval",method="item/permissions/requestApproval",@params=new {threadId=approvalThread,turnId=turnId,itemId="git-item",startedAtMs=1,environmentId="local",cwd=cwd,permissions=permissions}});
                    }
                    if(Json.Serialize(p).Contains("fixture-human-approval")) {
                        approvalThread=p["threadId"];approvalTurn=turnId;approvalCompleteFirst=Json.Serialize(p).Contains("fixture-human-approval-complete-first");
                        if(Json.Serialize(p).Contains("fixture-auto-review-denial")) Write(new {method="item/autoApprovalReview/completed",@params=new {threadId=approvalThread,turnId=turnId,targetItemId="tool-call",review=new {status="denied"},action=new {type="mcpToolCall",server="meristem",toolName="report"}}});
                        Write(new {id="human-approval",method="mcpServer/elicitation/request",@params=new {threadId=approvalThread,turnId=turnId,serverName="meristem",mode="form",message="fixture approval",requestedSchema=new {type="object",properties=new {}},_meta=new {codex_approval_kind="mcp_tool_call",connector_id="meristem",tool_name="report",tool_params=new {report=new {summary="fixture"}}}}});
                    }
                    if(Json.Serialize(p).Contains("fixture-question")) {
                        approvalThread=p["threadId"];approvalTurn=turnId;
                        var questions=new List<object>{new {id="format",header="Format",question="Which format?",isOther=true,isSecret=false,options=new[]{new {label="JSON",description="Structured"},new {label="Text",description="Plain text"}}}};
                        if(Json.Serialize(p).Contains("fixture-question-multiple"))questions.Add(new {id="reason",header="Reason",question="Why?",isOther=true,isSecret=false,options=(object)null});
                        Write(new {id="human-approval",method="item/tool/requestUserInput",@params=new {threadId=approvalThread,turnId=turnId,itemId="question-item",isBlocking=true,autoResolutionMs=(object)null,questions=questions}});
                    }
                    if(Json.Serialize(p).Contains("fixture-mcp-report")) {
                        string file=Path.Combine(Directory.GetCurrentDirectory(),"mcp-report.json");var report=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
                        report["metadata"]=new Dictionary<string,object>{{"x-codex-turn-metadata",new Dictionary<string,object>{{"thread_id",p["threadId"]},{"turn_id",turnId}}}};File.WriteAllText(file,Json.Serialize(report));
                        string node=report.ContainsKey("nodeExecutable")?(string)report["nodeExecutable"]:"node",helper=Path.Combine(Path.GetDirectoryName((string)report["entryPoint"]),"..","test","fixtures","native-mcp-client.js");
                        if(report.ContainsKey("verifySpoofs")) {
                            var spoof=new Dictionary<string,object>(report);spoof["output"]=(string)report["output"]+".helper-spoof";
                            spoof["direct"]=new {method="mcp",name=report["name"],args=report["args"],metadata=report["metadata"]};
                            File.WriteAllText(file+".helper",Json.Serialize(spoof));RunMcp(node,helper,file+".helper");
                            spoof.Remove("direct");spoof["descendant"]=true;spoof["output"]=(string)report["output"]+".descendant-spoof";
                            File.WriteAllText(file+".descendant",Json.Serialize(spoof));RunMcp(node,helper,file+".descendant");
                        }
                        RunMcp(node,helper,file);
                    }
                    if(Json.Serialize(p).Contains("fixture-complete-before-ack")||File.Exists(Path.Combine(Directory.GetCurrentDirectory(),"complete-turn"))) Write(new { method="turn/completed", @params=new { threadId=p["threadId"], turn=new { id=turnId,status="completed" } } });
                    result=new { turn=new { id=turnId, status="inProgress" } }; break;
                case "spawn": {
                    var psi=new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, "ticker \""+(string)p["marker"]+"\"");
                    psi.UseShellExecute=false; psi.CreateNoWindow=true; var child=Process.Start(psi); result=new { pid=child.Id }; break;
                }
            }
            Write(new { id=m["id"], result=result });
        }
        return 0;
    }
}
