'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Brain, MessageSquare, MessageSquarePlus, Pin } from 'lucide-react';
import { toast } from 'sonner';

import { PageBody, PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import type { Conversation, Memory, Project } from '@/db/schema';
import { api } from '@/lib/client/api';
import { formatRelative } from '@/lib/utils';

export function ProjectDetail({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getProject(projectId)
      .then((data) => {
        if (cancelled) return;
        setProject(data.project);
        setConversations(data.conversations);
        setMemories(data.memories);
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error('Could not load the project', {
            description: error instanceof Error ? error.message : undefined,
          });
        }
      })
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) {
    return (
      <PageBody>
        <Skeleton className="h-40 w-full" />
      </PageBody>
    );
  }

  if (!project) {
    return (
      <PageBody>
        <EmptyState
          title="Project not found"
          description="It may have been deleted."
          action={
            <Button asChild variant="secondary">
              <Link href="/projects">Back to projects</Link>
            </Button>
          }
        />
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader
        title={project.name}
        description={project.description ?? undefined}
        actions={
          <Button asChild size="sm">
            <Link href={`/chat?project=${project.id}`}>
              <MessageSquarePlus />
              New chat
            </Link>
          </Button>
        }
      />

      <PageBody className="space-y-6">
        {project.systemPrompt ? (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Instructions
            </h2>
            <pre className="whitespace-pre-wrap rounded-lg border border-border bg-card px-4 py-3 font-mono text-xs leading-relaxed text-muted-foreground">
              {project.systemPrompt}
            </pre>
          </section>
        ) : null}

        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <MessageSquare className="size-3.5" />
            Conversations
            <Badge variant="muted">{conversations.length}</Badge>
          </h2>

          {conversations.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground">No chats in this project yet.</p>
              <Button asChild size="sm" variant="secondary" className="mt-3">
                <Link href={`/chat?project=${project.id}`}>Start one</Link>
              </Button>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <Link
                    href={`/chat/${conversation.id}`}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5 transition-colors hover:border-primary/30"
                  >
                    {conversation.pinned ? <Pin className="size-3 shrink-0 text-primary" /> : null}
                    <span className="min-w-0 flex-1 truncate text-sm">{conversation.title}</span>
                    <span className="shrink-0 text-2xs text-muted-foreground">
                      {conversation.messageCount} msgs · {formatRelative(conversation.lastMessageAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Brain className="size-3.5" />
            Project memory
            <Badge variant="muted">{memories.length}</Badge>
          </h2>

          {memories.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              Memories captured in this project appear here, and stay scoped to it.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {memories.map((memory) => (
                <li
                  key={memory.id}
                  className="rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm leading-relaxed"
                >
                  {memory.pinned ? <Pin className="mr-1.5 inline size-3 text-primary" /> : null}
                  {memory.content}
                  <span className="ml-2 text-2xs text-muted-foreground">{memory.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageBody>
    </>
  );
}
