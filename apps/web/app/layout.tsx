import type { Metadata } from 'next';
import './globals.css';
import './imports.css';
export const metadata: Metadata = { title: 'KFF · 运营工作台', description: '账号、环境与可靠执行工作台' };
export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="zh-CN"><body>{children}</body></html>; }
