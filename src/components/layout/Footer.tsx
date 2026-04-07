import Image from "next/image";
import { getSiteStats } from "@/lib/tinylytics";

export default async function Footer() {
  const stats = await getSiteStats();
  return (
    <footer className="mt-auto">
      <div className="divider" />
      <div className="max-w-5xl mx-auto px-6 py-10">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="text-center md:text-left">
            <p className="text-sm text-gray-500">
              &copy; {new Date().getFullYear()} Samuel Lison
            </p>
            <p className="text-xs text-gray-600 mt-1">
              Self-owned. Self-hosted. Fediverse-native.
            </p>
            {stats && (
              <p className="text-xs text-gray-700 mt-1 font-mono">
                {stats.totalHits.toLocaleString()} visits
                {stats.totalKudos > 0 && ` · ${stats.totalKudos} kudos`}
              </p>
            )}
          </div>

          {/* Center: Small Web badge + Webring */}
          <div className="flex items-center gap-4">
            <img
              src="https://camo.githubusercontent.com/05046a28621d58344a06ba01b0c99bd44538f39c5a01e4e3b769f57de2f3f61c/68747470733a2f2f6b616769666565646261636b2e6f72672f6173736574732f66696c65732f323032352d31312d32372f313736343235303937332d3730383336392d38387833312d322e676966"
              alt="Small Web"
              width={100}
              height={32}
              className="opacity-70 hover:opacity-100 transition-opacity"
            />
            <a
              href="https://links.babylondreams.de"
              className="text-sm text-gray-400 hover:text-accent-400 transition-colors"
            >
              Webring: &#128760;&#128141;
            </a>
          </div>

          {/* Right: Links */}
          <div className="flex items-center gap-5 text-gray-500">
            <span className="text-xs text-gray-600 font-mono">
              @samuel@samuellison.com
            </span>

            <a
              href="/feed.xml"
              className="hover:text-accent-400 transition-colors"
              title="RSS Feed"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6.18 15.64a2.18 2.18 0 010 4.36 2.18 2.18 0 010-4.36M4 4.44A15.56 15.56 0 0119.56 20h-2.83A12.73 12.73 0 004 7.27V4.44m0 5.66a9.9 9.9 0 019.9 9.9h-2.83A7.07 7.07 0 004 12.93V10.1z" />
              </svg>
            </a>

            <a
              href="mailto:samuel@samuellison.com"
              className="hover:text-accent-400 transition-colors"
              title="Email"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
              </svg>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
