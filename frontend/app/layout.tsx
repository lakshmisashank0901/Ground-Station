import type { Metadata, Viewport } from "next";
import "./globals.css";
import { MissionHeader } from "@/components/mission-header";
import { SidebarNav } from "@/components/sidebar-nav";
import { LiveDataProvider } from "@/lib/live-data";

export const metadata: Metadata = {
  title: { default: "Ground Station", template: "%s · Ground Station" },
  description: "AI-assisted satellite ground station – mission control console",
};

export const viewport: Viewport = { themeColor: "#06080b" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-screen overflow-hidden">
        <LiveDataProvider>
          <div className="flex h-full">
            <SidebarNav />
            <div className="flex min-w-0 flex-1 flex-col">
              <MissionHeader />
              <main className="min-h-0 flex-1 overflow-auto p-3">{children}</main>
            </div>
          </div>
        </LiveDataProvider>
      </body>
    </html>
  );
}
