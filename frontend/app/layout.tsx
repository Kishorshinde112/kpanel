import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Suspense } from "react";
import { AuthProvider } from "../context/AuthContext";
import { DashboardLayout } from "../components/layout/DashboardLayout";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "K-Panel | VPS Management",
  description: "Lightweight alternative to Hostinger hPanel / Coolify",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        <Suspense fallback={<div className="min-h-screen bg-background" />}>
          <AuthProvider>
            <DashboardLayout>
              {children}
            </DashboardLayout>
          </AuthProvider>
        </Suspense>
      </body>
    </html>
  );
}