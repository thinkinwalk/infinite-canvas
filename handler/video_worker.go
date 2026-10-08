package handler

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "net/url"
    "os"
    "strings"
    "github.com/basketikun/infinite-canvas/model"
    "github.com/basketikun/infinite-canvas/repository"
    "github.com/basketikun/infinite-canvas/service"
)

// The worker remains on an internal network. Users access it through platform auth.
func VideoWorkerGateway(w http.ResponseWriter,r *http.Request,path string) {
    user,_:=service.UserFromContext(r.Context())
    base:=strings.TrimRight(os.Getenv("VIDEO_WORKER_URL"),"/")
    address,err:=url.Parse(base)
    if err!=nil || address.Host=="" || (address.Scheme!="http" && address.Scheme!="https") { w.WriteHeader(http.StatusServiceUnavailable); Fail(w,"服务器尚未部署视频剪辑服务"); return }
    parts:=strings.Split(strings.Trim(path,"/"),"/")
    action:=r.Method+" "+parts[0]
    var body io.Reader=r.Body
    switch {
    case action=="GET health" && len(parts)==1:
    case action=="POST media" && len(parts)==1:
    case action=="GET media" && len(parts)==2:
        if !workerOwned(w,user.ID,"media",parts[1]) { return }
    case action=="POST jobs" && len(parts)==1:
        var job struct { Operation string `json:"operation"`; Inputs map[string]any `json:"inputs"`; Options map[string]any `json:"options"` }
        if json.NewDecoder(r.Body).Decode(&job)!=nil { Fail(w,"处理任务格式不正确"); return }
        for _,value:=range job.Inputs {
            files:=[]string{}
            switch file:=value.(type) { case string:files=append(files,file); case []any:for _,entry:=range file { id,ok:=entry.(string); if !ok { Fail(w,"素材格式不正确"); return }; files=append(files,id) }; default:Fail(w,"素材格式不正确"); return }
            for _,id:=range files { if !workerOwned(w,user.ID,"media",id) { return } }
        }
        encoded,_:=json.Marshal(job); body=bytes.NewReader(encoded)
    case (action=="GET jobs" && len(parts)==2) || (action=="POST jobs" && len(parts)==3 && parts[2]=="cancel"):
        if !workerOwned(w,user.ID,"job",parts[1]) { return }
    default:http.NotFound(w,r); return
    }
    encodedPath:=[]string{}; for _,part:=range parts { encodedPath=append(encodedPath,url.PathEscape(part)) }
    request,err:=http.NewRequestWithContext(r.Context(),r.Method,base+"/"+strings.Join(encodedPath,"/"),body); if err!=nil { Fail(w,"处理服务地址无效"); return }
    request.Header.Set("X-Canvas-Worker","1")
    if token:=os.Getenv("VIDEO_WORKER_TOKEN"); token!="" { request.Header.Set("Authorization","Bearer "+token) }
    if contentType:=r.Header.Get("Content-Type"); contentType!="" { request.Header.Set("Content-Type",contentType) }
    if rangeValue:=r.Header.Get("Range"); rangeValue!="" { request.Header.Set("Range",rangeValue) }
    response,err:=aiHTTPClient.Do(request); if err!=nil { w.WriteHeader(http.StatusBadGateway); Fail(w,"视频处理服务连接失败"); return }; defer response.Body.Close()
    if action=="GET media" {
        for _,name:=range []string{"Content-Type","Content-Length","Content-Range","Accept-Ranges"} { if value:=response.Header.Get(name); value!="" { w.Header().Set(name,value) } }
        w.Header().Set("Cache-Control","private, no-store"); w.WriteHeader(response.StatusCode); _,_=io.Copy(w,response.Body); return
    }
    data,err:=io.ReadAll(response.Body); if err!=nil { w.WriteHeader(http.StatusBadGateway); Fail(w,"处理服务响应读取失败"); return }
    if response.StatusCode<400 {
        var payload struct { ID string `json:"id"`; Result struct { File string `json:"file"`; Files []string `json:"files"` } `json:"result"` }
        if json.Unmarshal(data,&payload)==nil {
            if action=="POST media" { err=saveWorkerOwner(user.ID,"media",payload.ID) }
            if action=="POST jobs" { err=saveWorkerOwner(user.ID,"job",payload.ID) }
            if action=="GET jobs" {
                files:=payload.Result.Files; if payload.Result.File!="" { files=append(files,payload.Result.File) }
                for _,id:=range files { if err=saveWorkerOwner(user.ID,"media",id); err!=nil { break } }
            }
            if err!=nil { w.WriteHeader(http.StatusInternalServerError); Fail(w,"任务或素材归属保存失败"); return }
        }
    }
    w.Header().Set("Content-Type","application/json"); w.Header().Set("Cache-Control","private, no-store"); w.WriteHeader(response.StatusCode); _,_=w.Write(data)
}
func workerOwned(w http.ResponseWriter,userID,kind,id string) bool {
    item,found,err:=repository.GetReferenceMediaOwner("worker-"+kind+":"+id)
    if err!=nil { FailError(w,err); return false }
    if !found || item.UserID!=userID { w.WriteHeader(http.StatusNotFound); Fail(w,"处理任务或素材不存在，或无权访问"); return false }; return true
}
func saveWorkerOwner(userID,kind,id string) error {
    if id=="" { return fmt.Errorf("处理服务未返回素材或任务编号") }
    key:="worker-"+kind+":"+id
    existing,found,err:=repository.GetReferenceMediaOwner(key); if err!=nil { return err }
    if found { if existing.UserID!=userID { return fmt.Errorf("处理服务返回了不属于该用户的编号") }; return nil }
    return repository.SaveReferenceMediaOwner(model.ReferenceMediaOwner{ID:key,UserID:userID})
}
