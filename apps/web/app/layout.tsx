import "./globals.css";
export const metadata = {
  title: "StreamForge · Media infrastructure",
  description: "Upload, process, and deliver video from one workspace.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
