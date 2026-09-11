'use client';
export default function ErrorPage({ reset }: { reset: () => void }) { return <main className="fatal"><h1>工作台暂时无法加载</h1><p>已保存的任务不会因此丢失。请重试加载。</p><button onClick={reset}>重新加载</button></main>; }
