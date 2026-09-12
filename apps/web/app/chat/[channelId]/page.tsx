import {notFound} from 'next/navigation';
import {uuid} from '@kff/contracts';
import VisitorChat from '../../../components/visitor-chat';
export default async function ChatPage({params}:{params:Promise<{channelId:string}>}){
  const {channelId}=await params;if(!uuid.safeParse(channelId).success)notFound();
  return <VisitorChat channelId={channelId}/>;
}
