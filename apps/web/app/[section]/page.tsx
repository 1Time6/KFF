import { notFound } from 'next/navigation';
import Workbench from '../../components/workbench';
export default async function Section({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!['overview', 'accounts', 'environments', 'tasks', 'runs', 'capabilities', 'templates', 'collections', 'schedules'].includes(section)) notFound();
  return <Workbench section={section} />;
}
