"use client";

import { useState } from "react";
import { HelpCircle, PenLine, SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Clarification } from "@/lib/chat/protocol";
import { cn } from "@/lib/utils";

export function formatClarificationAnswer(c: Clarification, answers: Record<number, string>): string {
  const entries = c.questions.map((q, i) => [q.question, answers[i]] as const).filter(([, a]) => a);
  if (entries.length === 1 && c.questions.length === 1) return entries[0][1]!;
  return entries.map(([q, a]) => `- ${q} → ${a}`).join("\n");
}

/** Questions de précision proposées par le modèle : sélection en un geste ou réponse libre. */
export function ClarificationCard({
  clarification,
  disabled,
  onAnswer,
  onFreeAnswer,
}: {
  clarification: Clarification;
  disabled: boolean;
  onAnswer: (text: string) => void;
  onFreeAnswer: () => void;
}) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const single = clarification.questions.length === 1;
  const answeredCount = Object.keys(answers).length;

  function pick(index: number, option: string) {
    if (single) {
      onAnswer(formatClarificationAnswer(clarification, { [index]: option }));
      return;
    }
    setAnswers((a) => {
      const next = { ...a };
      if (next[index] === option) delete next[index];
      else next[index] = option;
      return next;
    });
  }

  return (
    <div className="mt-4 rounded-3xl bg-muted p-4" role="group" aria-label="Précisions demandées">
      <p className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <HelpCircle className="size-3.5" />
        Quelques précisions aideraient à mieux répondre
      </p>
      <div className="flex flex-col gap-4">
        {clarification.questions.map((q, i) => (
          <div key={i}>
            <p className="mb-2 text-sm font-medium">{q.question}</p>
            {q.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((opt) => {
                  const selected = answers[i] === opt;
                  return (
                    <button
                      key={opt}
                      type="button"
                      disabled={disabled}
                      onClick={() => pick(i, opt)}
                      aria-pressed={selected}
                      className={cn(
                        "rounded-full px-3.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
                        selected ? "bg-primary text-primary-foreground" : "bg-background hover:bg-accent",
                      )}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!single && (
          <Button size="sm" disabled={disabled || answeredCount === 0} onClick={() => onAnswer(formatClarificationAnswer(clarification, answers))}>
            <SendHorizontal /> Envoyer {answeredCount > 0 ? `(${answeredCount}/${clarification.questions.length})` : ""}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onFreeAnswer} className="text-muted-foreground">
          <PenLine /> Répondre librement
        </Button>
      </div>
    </div>
  );
}
