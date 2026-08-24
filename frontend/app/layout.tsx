import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "K-Panel | Control Center",
  description: "Minimalist VPS Management",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-black text-white min-h-screen">
        {children}
      </body>
    </html>
  );
}
