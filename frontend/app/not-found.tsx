import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted">
      <div className="num text-2xl text-ink">404</div>
      <div>Page not found.</div>
      <Link href="/dashboard" className="text-accent hover:underline">
        Back to dashboard
      </Link>
    </div>
  );
}
