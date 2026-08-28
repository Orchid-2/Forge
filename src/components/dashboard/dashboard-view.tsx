'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  BarChart3,
  Brain,
  Check,
  Flame,
  MessageSquare,
  Plus,
  Target,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageBody, PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, type GoalWithEntries, type StatsResponse } from '@/lib/client/api';
import { formatCompact, formatRelative } from '@/lib/utils';

const RANGES = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
];

export function DashboardView() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [goals, setGoals] = useState<GoalWithEntries[]>([]);
  const [days, setDays] = useState('30');
  const [loading, setLoading] = useState(true);
  const [creatingGoal, setCreatingGoal] = useState(false);

  const load = async (window: string) => {
    setLoading(true);
    try {
      const [statsResult, goalsResult] = await Promise.all([
        api.getStats(Number(window)),
        api.listGoals(),
      ]);
      setStats(statsResult);
      setGoals(goalsResult.goals);
    } catch (error) {
      toast.error('Could not load the dashboard', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(days);
  }, [days]);

  const logGoal = async (goal: GoalWithEntries, value: number) => {
    try {
      const { goal: updated } = await api.logGoal(goal.id, value);
      setGoals((rows) => rows.map((g) => (g.id === goal.id ? { ...g, ...updated } : g)));
    } catch {
      toast.error('Could not log progress');
    }
  };

  return (
    <>
      <PageHeader
        title="Dashboard"
        actions={
          <Tabs value={days} onValueChange={setDays}>
            <TabsList className="h-7">
              {RANGES.map((range) => (
                <TabsTrigger key={range.value} value={range.value} className="h-5 px-2 text-xs">
                  {range.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      />

      <PageBody className="max-w-6xl space-y-6">
        {loading && !stats ? (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
            <Skeleton className="h-64" />
          </div>
        ) : !stats ? null : (
          <>
            {/* Headline numbers */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label="Conversations"
                value={formatCompact(stats.totals.conversations)}
                icon={<MessageSquare />}
                accent="var(--chart-2)"
              />
              <StatTile
                label="Messages"
                value={formatCompact(stats.totals.messages)}
                icon={<Activity />}
                accent="var(--chart-1)"
                sub={`${stats.derived.avgMessagesPerDay}/day on active days`}
              />
              <StatTile
                label="Memories"
                value={formatCompact(stats.totals.memories)}
                icon={<Brain />}
                accent="var(--chart-4)"
                sub={stats.totals.pinnedMemories ? `${stats.totals.pinnedMemories} pinned` : undefined}
              />
              <StatTile
                label="Tokens"
                value={formatCompact(stats.totals.tokens)}
                icon={<BarChart3 />}
                accent="var(--chart-3)"
                sub={stats.derived.streak > 0 ? `${stats.derived.streak}-day streak` : undefined}
              />
            </div>

            {/* Activity + memory growth */}
            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Activity</CardTitle>
                </CardHeader>
                <CardContent className="pl-0">
                  {stats.totals.messages === 0 ? (
                    <ChartEmpty label="No messages yet" />
                  ) : (
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={stats.series} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="messagesFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" vertical={false} />
                        <XAxis
                          dataKey="day"
                          tickFormatter={shortDay}
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          axisLine={false}
                          tickLine={false}
                          minTickGap={24}
                        />
                        <YAxis
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          axisLine={false}
                          tickLine={false}
                          width={32}
                          allowDecimals={false}
                        />
                        <RechartsTooltip content={<ChartTooltip unit="messages" />} />
                        <Area
                          type="monotone"
                          dataKey="messages"
                          stroke="hsl(var(--chart-1))"
                          strokeWidth={1.75}
                          fill="url(#messagesFill)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Memory growth</CardTitle>
                </CardHeader>
                <CardContent className="pl-0">
                  {stats.totals.memories === 0 ? (
                    <ChartEmpty label="No memories yet" />
                  ) : (
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={stats.series} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="memoryFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="hsl(var(--chart-4))" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="hsl(var(--chart-4))" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" vertical={false} />
                        <XAxis
                          dataKey="day"
                          tickFormatter={shortDay}
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          axisLine={false}
                          tickLine={false}
                          minTickGap={30}
                        />
                        <YAxis
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          axisLine={false}
                          tickLine={false}
                          width={32}
                          allowDecimals={false}
                        />
                        <RechartsTooltip content={<ChartTooltip unit="total memories" dataKey="memoryTotal" />} />
                        <Area
                          type="monotone"
                          dataKey="memoryTotal"
                          stroke="hsl(var(--chart-4))"
                          strokeWidth={1.75}
                          fill="url(#memoryFill)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Breakdown row */}
            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Memory by kind</CardTitle>
                </CardHeader>
                <CardContent>
                  {stats.memoryKinds.length === 0 ? (
                    <ChartEmpty label="Nothing stored yet" height={160} />
                  ) : (
                    <div className="flex items-center gap-4">
                      <ResponsiveContainer width="50%" height={150}>
                        <PieChart>
                          <Pie
                            data={stats.memoryKinds}
                            dataKey="count"
                            nameKey="kind"
                            innerRadius={38}
                            outerRadius={62}
                            paddingAngle={2}
                            strokeWidth={0}
                          >
                            {stats.memoryKinds.map((entry, index) => (
                              <Cell key={entry.kind} fill={`hsl(var(--chart-${(index % 5) + 1}))`} />
                            ))}
                          </Pie>
                          <RechartsTooltip content={<ChartTooltip unit="memories" nameKey="kind" />} />
                        </PieChart>
                      </ResponsiveContainer>

                      <ul className="flex-1 space-y-1.5 text-xs">
                        {stats.memoryKinds.slice(0, 6).map((entry, index) => (
                          <li key={entry.kind} className="flex items-center gap-2">
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ background: `hsl(var(--chart-${(index % 5) + 1}))` }}
                            />
                            <span className="flex-1 truncate capitalize text-muted-foreground">
                              {entry.kind}
                            </span>
                            <span className="font-mono tabular-nums">{entry.count}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Models used</CardTitle>
                </CardHeader>
                <CardContent className="pl-0">
                  {stats.topModels.length === 0 ? (
                    <ChartEmpty label="No replies yet" height={160} />
                  ) : (
                    <ResponsiveContainer width="100%" height={150}>
                      <BarChart
                        data={stats.topModels}
                        layout="vertical"
                        margin={{ top: 0, right: 12, left: 0, bottom: 0 }}
                      >
                        <XAxis type="number" hide />
                        <YAxis
                          type="category"
                          dataKey="model"
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          axisLine={false}
                          tickLine={false}
                          width={110}
                          tickFormatter={(v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v)}
                        />
                        <RechartsTooltip content={<ChartTooltip unit="replies" nameKey="model" />} />
                        <Bar dataKey="count" fill="hsl(var(--chart-2))" radius={[0, 3, 3, 0]} barSize={12} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Recent activity</CardTitle>
                </CardHeader>
                <CardContent>
                  {stats.recentActivity.length === 0 ? (
                    <ChartEmpty label="Nothing yet" height={160} />
                  ) : (
                    <ul className="space-y-2 text-xs">
                      {stats.recentActivity.slice(0, 7).map((event) => (
                        <li key={event.id} className="flex items-start gap-2">
                          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary/60" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate">{event.title}</p>
                            <p className="text-2xs text-muted-foreground">
                              {activityLabel(event.type)}
                              {event.detail ? ` · ${event.detail}` : ''} ·{' '}
                              {formatRelative(event.createdAt)}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Progress tracking */}
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Progress</h2>
                <Button variant="ghost" size="sm" onClick={() => setCreatingGoal(true)}>
                  <Plus />
                  New tracker
                </Button>
              </div>

              {goals.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={<Target />}
                    title="Track anything you want"
                    description="Counters, streaks and targets — pages written, workouts done, days without a cigarette. Log them here and they show up alongside your conversation activity."
                    action={
                      <Button onClick={() => setCreatingGoal(true)}>
                        <Plus />
                        Create a tracker
                      </Button>
                    }
                    className="py-10"
                  />
                </Card>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {goals.map((goal) => (
                    <GoalCard
                      key={goal.id}
                      goal={goal}
                      onLog={(value) => void logGoal(goal, value)}
                      onDelete={async () => {
                        setGoals((rows) => rows.filter((g) => g.id !== goal.id));
                        try {
                          await api.deleteGoal(goal.id);
                        } catch {
                          void load(days);
                        }
                      }}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* Recent conversations */}
            {stats.recentConversations.length > 0 ? (
              <section>
                <h2 className="mb-3 text-sm font-semibold">Pick up where you left off</h2>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {stats.recentConversations.map((conversation) => (
                    <Link
                      key={conversation.id}
                      href={`/chat/${conversation.id}`}
                      className="group rounded-lg border border-border bg-card px-3.5 py-3 transition-colors hover:border-primary/40"
                    >
                      <p className="truncate text-sm font-medium">{conversation.title}</p>
                      <p className="mt-1 text-2xs text-muted-foreground">
                        {conversation.messageCount} messages ·{' '}
                        {formatRelative(conversation.lastMessageAt)}
                      </p>
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </PageBody>

      <GoalDialog
        open={creatingGoal}
        onClose={() => setCreatingGoal(false)}
        onCreated={(goal) => {
          setGoals((rows) => [...rows, goal]);
          setCreatingGoal(false);
        }}
      />
    </>
  );
}

function StatTile({
  label,
  value,
  sub,
  icon,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="[&_svg]:size-3.5" style={{ color: `hsl(${accent})` }}>
          {icon}
        </span>
      </div>
      <p className="mt-2 font-mono text-2xl tabular-nums tracking-tight">{value}</p>
      {sub ? <p className="mt-0.5 text-2xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function GoalCard({
  goal,
  onLog,
  onDelete,
}: {
  goal: GoalWithEntries;
  onLog: (value: number) => void;
  onDelete: () => void;
}) {
  const percent = goal.target > 0 ? Math.min(100, (goal.current / goal.target) * 100) : 0;

  return (
    <div className="group relative rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-base" style={{ color: `hsl(${goal.accent})` }}>
            {goal.icon}
          </span>
          <span className="truncate text-sm font-medium">{goal.title}</span>
        </div>
        <button
          onClick={onDelete}
          className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          aria-label="Delete tracker"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="font-mono text-2xl tabular-nums">{formatCompact(goal.current)}</span>
        {goal.target > 0 ? (
          <span className="text-xs text-muted-foreground">/ {formatCompact(goal.target)}</span>
        ) : null}
        {goal.unit ? <span className="text-xs text-muted-foreground">{goal.unit}</span> : null}
      </div>

      {goal.kind === 'target' && goal.target > 0 ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full transition-all duration-500 ease-swift"
            style={{ width: `${percent}%`, background: `hsl(${goal.accent})` }}
          />
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between">
        {goal.streak > 0 ? (
          <Badge variant="muted" className="gap-1">
            <Flame className="size-2.5 text-primary" />
            {goal.streak}d
          </Badge>
        ) : (
          <span className="text-2xs text-muted-foreground">{goal.kind}</span>
        )}

        <Button size="xs" variant="secondary" onClick={() => onLog(1)}>
          <Check />
          Log
        </Button>
      </div>
    </div>
  );
}

function GoalDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (goal: GoalWithEntries) => void;
}) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('counter');
  const [unit, setUnit] = useState('');
  const [target, setTarget] = useState('');
  const [icon, setIcon] = useState('◎');

  useEffect(() => {
    if (open) {
      setTitle('');
      setKind('counter');
      setUnit('');
      setTarget('');
      setIcon('◎');
    }
  }, [open]);

  const create = async () => {
    if (!title.trim()) return;
    try {
      const { goal } = await api.createGoal({
        title: title.trim(),
        kind,
        unit: unit.trim(),
        target: Number(target) || 0,
        icon,
      });
      onCreated(goal);
      toast.success('Tracker created');
    } catch (error) {
      toast.error('Could not create the tracker', {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New tracker</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4 pb-2">
          <div className="flex gap-3">
            <Field label="Icon" className="w-20">
              <Input
                value={icon}
                onChange={(e) => setIcon(e.target.value.slice(0, 2))}
                className="text-center"
              />
            </Field>
            <Field label="Title" className="flex-1">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Pages written"
                autoFocus
              />
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Kind">
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="counter">Counter</SelectItem>
                  <SelectItem value="streak">Streak</SelectItem>
                  <SelectItem value="target">Target</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Unit">
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="pages" />
            </Field>
            <Field label="Target">
              <Input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="100"
                inputMode="numeric"
              />
            </Field>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!title.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Shared tooltip so every chart reads identically. */
function ChartTooltip({
  active,
  payload,
  label,
  unit,
  dataKey,
  nameKey,
}: {
  active?: boolean;
  payload?: Array<{ value: number; payload: Record<string, unknown> }>;
  label?: string;
  unit: string;
  dataKey?: string;
  nameKey?: string;
}) {
  if (!active || !payload?.length) return null;

  const point = payload[0];
  const heading = nameKey ? String(point.payload[nameKey] ?? '') : longDay(label ?? '');
  const value = dataKey ? Number(point.payload[dataKey]) : point.value;

  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-float">
      <p className="font-medium">{heading}</p>
      <p className="text-muted-foreground">
        <span className="font-mono tabular-nums text-foreground">{formatCompact(value)}</span> {unit}
      </p>
    </div>
  );
}

function ChartEmpty({ label, height = 200 }: { label: string; height?: number }) {
  return (
    <div
      className="flex items-center justify-center text-xs text-muted-foreground"
      style={{ height }}
    >
      {label}
    </div>
  );
}

/** "2026-08-28" → "28 Aug". Parsed as local time, matching how it was bucketed. */
function shortDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

function longDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year) return day;
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function activityLabel(type: string): string {
  return (
    {
      'conversation.created': 'New conversation',
      'memory.created': 'Memory saved',
      'memory.pruned': 'Memory pruned',
      'model.downloaded': 'Model downloaded',
      'project.created': 'Project created',
      'sync.completed': 'Synced',
      'goal.logged': 'Progress logged',
    }[type] ?? type
  );
}
