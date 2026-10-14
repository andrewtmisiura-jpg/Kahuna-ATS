import { ResumeClient } from "@/components/applicant/resume-client";

// Resume link target: the token arrives after "#", so it never reaches the server
// log. The client posts it once to /api/applicant/resume and continues to /apply.
export const metadata = { title: "Opening your application" };
export const dynamic = "force-dynamic";

export default function ResumePage() {
  return <ResumeClient />;
}
