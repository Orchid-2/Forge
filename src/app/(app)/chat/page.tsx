import type { Metadata } from 'next';

import { ChatView } from '@/components/chat/chat-view';

export const metadata: Metadata = { title: 'Chat' };

/**
 * New conversation.
 *
 * No record is created until the first message is sent, so opening and
 * abandoning this page leaves nothing behind in the sidebar.
 */
export default async function NewChatPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  return <ChatView projectId={project ?? null} />;
}
