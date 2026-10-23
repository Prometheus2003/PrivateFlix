import { connection } from "next/server";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PrivateFlix",
  description: "Private personal media library",
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
