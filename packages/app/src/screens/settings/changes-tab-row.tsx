import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Switch } from "@/components/ui/switch";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { settingsStyles } from "@/styles/settings";

/**
 * "Always open Changes in a tab" — a row in Settings → General.
 *
 * Reads and writes `ChangesPreferences` rather than app settings, because that is where the diff
 * preferences already live. The store is client-local and react-query backed, so the Changes pane
 * picks the new value up without any explicit propagation.
 *
 * The switch is disabled until the query resolves. `saveChangesPreferences` merges onto whatever is
 * in the cache, which is `DEFAULT_CHANGES_PREFERENCES` while the read is in flight, so a press
 * during that window both writes the other preferences back to their defaults and loses to the
 * resolving query, which overwrites the cache with the stale stored value.
 *
 * The row renders on every form factor even though `shouldRouteDiffsToChangesTab` ignores the
 * preference below the `sm` breakpoint, where #2298 has no Changes tab to route to. Settings is a
 * reference surface, so a row that disappears while you drag a window edge reads as a bug; the
 * preference is simply inert at that width, and saying so in the hint cost more confusion than it
 * bought — "wide layouts" is not a term this product uses anywhere else.
 */
export function ChangesTabRow() {
  const { t } = useTranslation();
  const { preferences, isLoading, updatePreferences } = useChangesPreferences();

  const handleChange = useCallback(
    (alwaysOpenInTab: boolean) => void updatePreferences({ alwaysOpenInTab }),
    [updatePreferences],
  );

  const label = t("settings.general.alwaysOpenChangesInTab.label");

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.general.alwaysOpenChangesInTab.description")}
        </Text>
      </View>
      <Switch
        value={preferences.alwaysOpenInTab}
        onValueChange={handleChange}
        disabled={isLoading}
        accessibilityLabel={label}
        testID="always-open-changes-in-tab-toggle"
      />
    </View>
  );
}
