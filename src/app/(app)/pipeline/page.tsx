"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage } from "@/lib/client/api";

/**
 * The lead pipeline — a small, dependency-free CRM.
 *
 * A board of the configured stages with the contacts in each, the open tasks
 * (reminders) and a quick way to add a task. Everything here is real data
 * from the database; nothing is a placeholder.
 */

type Stage = {
  id: string;
  name: string;
  color: string;
  order: number;
  isWon: boolean;
  _count?: { contacts: number };
};

type PipelineContact = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  priority: string;
  stageId: string | null;
  convertedAt: string | null;
};

type Task = {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  dueAt: string | null;
  contactId: string | null;
  contact: { id: string; email: string; firstName: string | null } | null;
};

export default function PipelinePage() {
  const toast = useToast();
  const [stages, setStages] = useState<Stage[]>([]);
  const [contacts, setContacts] = useState<PipelineContact[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"board" | "tasks">("board");

  const [taskOpen, setTaskOpen] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: "", notes: "", contactId: "", dueAt: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [stageRes, contactRes, taskRes] = await Promise.all([
        api<{ stages: Stage[] }>("/api/pipeline/stages"),
        api<{ items: PipelineContact[] }>("/api/contacts?pageSize=200"),
        api<{ tasks: Task[] }>("/api/tasks?status=OPEN"),
      ]);
      setStages(stageRes.stages);
      setContacts(contactRes.items);
      setTasks(taskRes.tasks);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const moveContact = async (contactId: string, stageId: string) => {
    try {
      await api(`/api/contacts/${contactId}`, {
        method: "PATCH",
        body: JSON.stringify({ stageId }),
      });
      await load();
    } catch (e) {
      toast.push("error", errorMessage(e));
    }
  };

  const completeTask = async (id: string) => {
    try {
      await api(`/api/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "DONE" }),
      });
      await load();
    } catch (e) {
      toast.push("error", errorMessage(e));
    }
  };

  const createTask = async () => {
    if (!taskForm.title.trim()) {
      toast.push("error", "Give the task a title.");
      return;
    }
    setSaving(true);
    try {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: taskForm.title.trim(),
          notes: taskForm.notes.trim() || null,
          contactId: taskForm.contactId || null,
          dueAt: taskForm.dueAt ? new Date(taskForm.dueAt).toISOString() : null,
        }),
      });
      toast.push("success", "Task created.");
      setTaskOpen(false);
      setTaskForm({ title: "", notes: "", contactId: "", dueAt: "" });
      await load();
    } catch (e) {
      toast.push("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const contactsFor = (stageId: string) => contacts.filter((c) => c.stageId === stageId);

  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Your leads, the stage they are in, and the reminders you set."
        actions={
          <Button onClick={() => setTaskOpen(true)}>+ New task</Button>
        }
      />

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="mb-4 flex gap-1 border-b border-[var(--border)]">
        {(
          [
            { key: "board", label: "Board" },
            { key: "tasks", label: `Tasks (${tasks.length})` },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm transition ${
              tab === t.key
                ? "border-[var(--accent)] font-medium text-[var(--accent)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : tab === "board" ? (
        stages.length === 0 ? (
          <Card>
            <EmptyState title="No stages yet" description="Stages are created automatically the first time you open this page." />
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {stages.map((stage) => {
              const list = contactsFor(stage.id);
              return (
                <Card
                  key={stage.id}
                  title={
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }} />
                      {stage.name}
                      <span className="text-xs font-normal text-[var(--muted)]">{list.length}</span>
                    </span>
                  }
                >
                  {list.length === 0 ? (
                    <p className="text-xs text-[var(--muted)]">No contacts in this stage.</p>
                  ) : (
                    <ul className="space-y-2">
                      {list.slice(0, 20).map((c) => (
                        <li key={c.id} className="rounded-lg border border-[var(--border)] p-2.5">
                          <p className="truncate text-sm font-medium">
                            {[c.firstName, c.lastName].filter(Boolean).join(" ") || c.email}
                          </p>
                          <p className="truncate text-xs text-[var(--muted)]">{c.company ?? c.email}</p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {c.priority !== "MEDIUM" && (
                              <Badge tone={c.priority === "URGENT" || c.priority === "HIGH" ? "red" : "neutral"}>
                                {c.priority}
                              </Badge>
                            )}
                            {c.convertedAt && <Badge tone="green">Converted</Badge>}
                          </div>
                          <div className="mt-2">
                            <label htmlFor={`stage-${c.id}`} className="sr-only">
                              Move {c.email} to a stage
                            </label>
                            <Select
                              id={`stage-${c.id}`}
                              value={c.stageId ?? ""}
                              onChange={(e) => moveContact(c.id, e.target.value)}
                              className="text-xs"
                            >
                              <option value="">Move to…</option>
                              {stages.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </Select>
                          </div>
                        </li>
                      ))}
                      {list.length > 20 && (
                        <li className="text-xs text-[var(--muted)]">+{list.length - 20} more</li>
                      )}
                    </ul>
                  )}
                </Card>
              );
            })}
          </div>
        )
      ) : tasks.length === 0 ? (
        <Card>
          <EmptyState
            title="No open tasks"
            description="A task is a reminder: call back on Tuesday, send the proposal, follow up next week."
            action={<Button onClick={() => setTaskOpen(true)}>+ New task</Button>}
          />
        </Card>
      ) : (
        <Card title="Open tasks" description="Due tasks first.">
          <ul className="divide-y divide-[var(--border)]">
            {tasks.map((t) => {
              const overdue = t.dueAt ? new Date(t.dueAt).getTime() < Date.now() : false;
              return (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t.title}</p>
                    {t.notes && <p className="text-xs text-[var(--muted)]">{t.notes}</p>}
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {t.contact ? (
                        <span className="flex flex-wrap items-center gap-1.5">
                          {t.contact.email}
                          {t.dueAt && (
                            <span className={overdue ? "text-red-600 dark:text-red-400" : undefined}>
                              · due {new Date(t.dueAt).toLocaleDateString()}
                            </span>
                          )}
                        </span>
                      ) : t.dueAt ? (
                        <span className={overdue ? "text-red-600 dark:text-red-400" : undefined}>
                          due {new Date(t.dueAt).toLocaleDateString()}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <Button variant="secondary" onClick={() => completeTask(t.id)}>
                    Done
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Modal
        open={taskOpen}
        title="New task"
        onClose={() => setTaskOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTaskOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={createTask} loading={saving}>
              Create task
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Title" htmlFor="task-title">
            <Input
              id="task-title"
              value={taskForm.title}
              onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })}
              placeholder="Call back about the proposal"
            />
          </Field>
          <Field label="Contact" htmlFor="task-contact" hint="Optional — link the task to a lead.">
            <Select
              id="task-contact"
              value={taskForm.contactId}
              onChange={(e) => setTaskForm({ ...taskForm, contactId: e.target.value })}
            >
              <option value="">No contact</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.email}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due" htmlFor="task-due" hint="Optional.">
            <Input
              id="task-due"
              type="datetime-local"
              value={taskForm.dueAt}
              onChange={(e) => setTaskForm({ ...taskForm, dueAt: e.target.value })}
            />
          </Field>
          <Field label="Notes" htmlFor="task-notes">
            <Textarea
              id="task-notes"
              value={taskForm.notes}
              onChange={(e) => setTaskForm({ ...taskForm, notes: e.target.value })}
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}
