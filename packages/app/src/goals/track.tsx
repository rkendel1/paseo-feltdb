import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import type { AgentGoal } from "@getpaseo/protocol/agent-types";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { goalActions, goalStatusKey, type GoalAction } from "./presentation";

export function GoalTrack({
  goal,
  onAction,
}: {
  goal: AgentGoal | null;
  onAction: (action: GoalAction) => Promise<void>;
}): ReactElement | null {
  const { t } = useTranslation();
  const [pendingAction, setPendingAction] = useState<GoalAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAction = useCallback(
    (action: GoalAction) => {
      setPendingAction(action);
      setError(null);
      void onAction(action)
        .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
        .finally(() => setPendingAction(null));
    },
    [onAction],
  );

  if (!goal) return null;

  return (
    <View style={styles.root} testID="goal-track">
      <View style={styles.row}>
        <View style={styles.summary}>
          <View
            style={[
              styles.statusDot,
              goal.status === "active" && styles.statusDotActive,
              goal.status === "blocked" && styles.statusDotBlocked,
              (goal.status === "usageLimited" || goal.status === "budgetLimited") &&
                styles.statusDotLimited,
              goal.status === "complete" && styles.statusDotComplete,
            ]}
          />
          <Text style={styles.status} numberOfLines={1}>
            {t(goalStatusKey(goal.status))}
          </Text>
          <Text style={styles.objective} numberOfLines={1} testID="goal-track-objective">
            {goal.objective}
          </Text>
        </View>
        <View style={styles.actions}>
          {goalActions(goal).map((action) => (
            <GoalActionButton
              key={action}
              action={action}
              label={t(`goals.actions.${action}`)}
              pendingAction={pendingAction}
              onAction={handleAction}
            />
          ))}
        </View>
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert" testID="goal-track-error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function GoalActionButton({
  action,
  label,
  pendingAction,
  onAction,
}: {
  action: GoalAction;
  label: string;
  pendingAction: GoalAction | null;
  onAction: (action: GoalAction) => void;
}): ReactElement {
  const handlePress = useCallback(() => onAction(action), [action, onAction]);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={pendingAction !== null}
      loading={pendingAction === action}
      testID={`goal-track-${action}`}
      onPress={handlePress}
    >
      {label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    marginBottom: -theme.spacing[1],
    paddingBottom: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  row: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  summary: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  statusDot: {
    width: 6,
    height: 6,
    flexShrink: 0,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  statusDotActive: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  statusDotBlocked: {
    backgroundColor: theme.colors.statusDotDanger,
  },
  statusDotLimited: {
    backgroundColor: theme.colors.statusDotWarning,
  },
  statusDotComplete: {
    backgroundColor: theme.colors.statusDotSuccess,
  },
  status: {
    flexShrink: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  objective: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
  },
  error: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
}));
