import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import type { AgentGoal } from "@getpaseo/protocol/agent-types";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
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
    <View style={styles.outer} testID="goal-track">
      <View style={styles.track}>
        <View style={styles.surface}>
          <View style={styles.summary}>
            <StatusBadge
              label={t(goalStatusKey(goal.status))}
              variant={goal.status === "complete" ? "success" : undefined}
            />
            <Text style={styles.objective} numberOfLines={2} testID="goal-track-objective">
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
          {error ? (
            <Text style={styles.error} accessibilityRole="alert" testID="goal-track-error">
              {error}
            </Text>
          ) : null}
        </View>
      </View>
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
  outer: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    marginBottom: -theme.spacing[4],
  },
  surface: {
    alignSelf: "stretch",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderBottomWidth: 0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[6],
  },
  summary: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  objective: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    marginTop: theme.spacing[1],
  },
  error: {
    marginTop: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
}));
