import { useState, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Upload, FileText, Clock, CheckCircle2, AlertCircle, Download, Loader2, Trash2 } from "lucide-react";

interface RedlineJob {
  id: number;
  filename: string;
  status: string;
  changes_summary: string | null;
  created_at: string;
  completed_at: string | null;
  username?: string;
}

interface RedlineJobFull extends RedlineJob {
  original_text: string;
  edited_text: string;
}

function RedlineVersionBadge() {
  const { data } = useQuery<{ version: string }>({
    queryKey: ["/api/redline/version"],
    queryFn: () => apiRequest("GET", "/api/redline/version").then(r => r.json()),
    staleTime: Infinity,
  });
  if (!data?.version) return null;
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#e8312a]/15 text-[#e8312a] border border-[#e8312a]/30">
      v{data.version}
    </span>
  );
}

export default function Redline() {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [selectedJob, setSelectedJob] = useState<number | null>(null);
  const [viewTab, setViewTab] = useState<"edited" | "original" | "changes">("edited");
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  // Fetch job list
  const { data: jobs = [] } = useQuery<RedlineJob[]>({
    queryKey: ["/api/redline/jobs"],
    queryFn: () => apiRequest("GET", "/api/redline/jobs").then(r => r.json()),
    refetchInterval: 5000, // Poll while jobs are processing
  });

  // Fetch selected job detail
  const { data: jobDetail, isLoading: jobLoading } = useQuery<RedlineJobFull>({
    queryKey: ["/api/redline/jobs", selectedJob],
    queryFn: () => apiRequest("GET", `/api/redline/jobs/${selectedJob}`).then(r => r.json()),
    enabled: selectedJob !== null,
    refetchInterval: 3000, // Poll every 3s (cheap GET, stops mattering once completed)
  });

  const uploadFile = useCallback(async (file: File) => {
    if (!file.name.endsWith(".docx")) {
      alert("Please upload a .docx file");
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/redline/upload", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.message || "Upload failed");
        return;
      }
      const data = await res.json();
      setSelectedJob(data.jobId);
      qc.invalidateQueries({ queryKey: ["/api/redline/jobs"] });
    } catch (err: any) {
      alert("Upload failed: " + (err?.message || "Unknown error"));
    } finally {
      setUploading(false);
    }
  }, [qc]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }, [uploadFile]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    if (fileRef.current) fileRef.current.value = "";
  }, [uploadFile]);

  const downloadEdited = useCallback(() => {
    if (!jobDetail?.edited_text) return;
    const blob = new Blob([jobDetail.edited_text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = jobDetail.filename.replace(".docx", "-redlined.txt");
    a.click();
    URL.revokeObjectURL(url);
  }, [jobDetail]);

  // Auto-select latest processing job
  const processingJob = jobs.find(j => j.status === "processing");
  if (processingJob && selectedJob === null) {
    setSelectedJob(processingJob.id);
  }

  return (
    <div className="h-full overflow-y-auto" style={{ overscrollBehavior: "contain" }}>
      <div className="p-3 sm:p-6 max-w-5xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#e8312a]/10 flex items-center justify-center">
            <FileText className="w-5 h-5 text-[#e8312a]" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-foreground">Redline</h1>
              <RedlineVersionBadge />
            </div>
            <p className="text-xs text-muted-foreground">Upload a .docx article to sub-edit using StereoNET house style</p>
          </div>
        </div>

        {/* Upload zone */}
        <Card>
          <CardContent className="p-6">
            <div
              className={`border-2 border-dashed rounded-xl p-8 sm:p-12 text-center transition-all cursor-pointer ${
                dragOver
                  ? "border-[#e8312a] bg-[#e8312a]/5"
                  : "border-border hover:border-[#e8312a]/50 hover:bg-muted/30"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".docx"
                className="hidden"
                onChange={handleFileChange}
              />
              {uploading ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="w-10 h-10 text-[#e8312a] animate-spin" />
                  <p className="text-sm font-medium text-foreground">Uploading and processing...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <Upload className="w-10 h-10 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Drop a .docx file here or click to browse
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Powered by Claude Sonnet 4.6 via Anthropic API
                    </p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Job history + detail */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Job list */}
          <Card className="lg:col-span-1">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold text-foreground">History</CardTitle>
            </CardHeader>
            <CardContent className="px-2 pb-2">
              {jobs.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">No sub-edits yet</p>
              ) : (
                <div className="space-y-1 max-h-80 overflow-y-auto">
                  {jobs.map(job => (
                    <button
                      key={job.id}
                      onClick={() => { setSelectedJob(job.id); setViewTab("edited"); }}
                      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors text-xs ${
                        selectedJob === job.id
                          ? "bg-[#e8312a]/10 text-foreground"
                          : "hover:bg-muted/50 text-muted-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {job.status === "processing" && <Loader2 className="w-3.5 h-3.5 text-[#eab308] animate-spin shrink-0" />}
                        {job.status === "completed" && <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />}
                        {job.status === "error" && <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                        <span className="truncate font-medium">{job.filename}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-1">
                        {job.username && <span className="text-[#e8312a]/70 mr-1">{job.username.split("@")[0]}</span>}
                        {new Date(job.created_at + "Z").toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                        {job.status === "processing" && " — Processing..."}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Job detail */}
          <Card className="lg:col-span-2">
            <CardContent className="p-4">
              {!selectedJob ? (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <FileText className="w-12 h-12 mb-3 opacity-30" />
                  <p className="text-sm">Upload an article to get started</p>
                </div>
              ) : jobLoading || !jobDetail ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : jobDetail.status === "processing" ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <Loader2 className="w-10 h-10 text-[#e8312a] animate-spin mb-4" />
                  <p className="text-sm font-medium text-foreground">Redline is sub-editing your article...</p>
                  <p className="text-xs text-muted-foreground mt-1">This usually takes 30 to 60 seconds</p>
                </div>
              ) : jobDetail.status === "error" ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <AlertCircle className="w-10 h-10 text-red-400 mb-4" />
                  <p className="text-sm font-medium text-foreground">Sub-edit failed</p>
                  <p className="text-xs text-muted-foreground mt-1">Check the server logs or try again</p>
                </div>
              ) : (
                <div>
                  {/* Tabs */}
                  <div className="flex items-center gap-1 mb-4 border-b border-border pb-2">
                    {(["edited", "original", "changes"] as const).map(tab => (
                      <button
                        key={tab}
                        onClick={() => setViewTab(tab)}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                          viewTab === tab
                            ? "bg-[#e8312a]/10 text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {tab === "edited" ? "Sub-edited" : tab === "original" ? "Original" : "Changes"}
                      </button>
                    ))}
                    <button
                      onClick={downloadEdited}
                      className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[#e8312a] text-white hover:bg-[#c42a24] transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download
                    </button>
                  </div>

                  {/* Content */}
                  <div className="max-h-[60vh] overflow-y-auto rounded-lg bg-muted/30 p-4">
                    <pre className="whitespace-pre-wrap text-sm text-foreground font-sans leading-relaxed">
                      {viewTab === "edited" && jobDetail.edited_text}
                      {viewTab === "original" && jobDetail.original_text}
                      {viewTab === "changes" && (jobDetail.changes_summary || "No changes summary available")}
                    </pre>
                  </div>

                  {/* Filename + timestamp */}
                  <div className="flex items-center justify-between mt-3 text-[10px] text-muted-foreground">
                    <span>{jobDetail.filename}</span>
                    {jobDetail.completed_at && (
                      <span>Completed {new Date(jobDetail.completed_at + "Z").toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

      </div>
    </div>
  );
}
