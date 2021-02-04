/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import _ from 'lodash';
import { History } from 'history';
import { merge, Subscription } from 'rxjs';
import React, { useEffect, useCallback, useState } from 'react';

import { useKibana } from '../../../kibana_react/public';
import { DashboardConstants } from '../dashboard_constants';
import { DashboardTopNav } from './top_nav/dashboard_top_nav';
import { DashboardAppServices, DashboardEmbedSettings, DashboardRedirect } from './types';
import {
  getInputSubscription,
  getOutputSubscription,
  getFiltersSubscription,
  getSearchSessionIdFromURL,
  getDashboardContainerInput,
  getChangesFromAppStateForContainerState,
} from './dashboard_app_functions';
import {
  useDashboardBreadcrumbs,
  useDashboardContainer,
  useDashboardStateManager,
  useSavedDashboard,
} from './hooks';

import { removeQueryParam } from '../services/kibana_utils';
import { IndexPattern } from '../services/data';
import { EmbeddableRenderer } from '../services/embeddable';
import { DashboardContainerInput } from '.';

export interface DashboardAppProps {
  history: History;
  savedDashboardId?: string;
  redirectTo: DashboardRedirect;
  embedSettings?: DashboardEmbedSettings;
}

export function DashboardApp({
  savedDashboardId,
  embedSettings,
  redirectTo,
  history,
}: DashboardAppProps) {
  const {
    data,
    core,
    onAppLeave,
    uiSettings,
    indexPatterns: indexPatternService,
    dashboardCapabilities,
  } = useKibana<DashboardAppServices>().services;

  const [lastReloadTime, setLastReloadTime] = useState(0);
  const [indexPatterns, setIndexPatterns] = useState<IndexPattern[]>([]);

  const savedDashboard = useSavedDashboard(savedDashboardId, history);
  const { dashboardStateManager, viewMode, setViewMode } = useDashboardStateManager(
    savedDashboard,
    history
  );
  const dashboardContainer = useDashboardContainer(dashboardStateManager, history, false);

  const refreshDashboardContainer = useCallback(
    (lastReloadRequestTime?: number) => {
      if (!dashboardContainer || !dashboardStateManager) {
        return;
      }

      const changes = getChangesFromAppStateForContainerState({
        dashboardContainer,
        appStateDashboardInput: getDashboardContainerInput({
          isEmbeddedExternally: Boolean(embedSettings),
          dashboardStateManager,
          lastReloadRequestTime,
          dashboardCapabilities,
          query: data.query,
        }),
      });

      if (changes) {
        // state keys change in which likely won't need a data fetch
        const noRefetchKeys: Array<keyof DashboardContainerInput> = [
          'viewMode',
          'title',
          'description',
          'expandedPanelId',
          'useMargins',
          'isEmbeddedExternally',
          'isFullScreenMode',
        ];
        const shouldRefetch = Object.keys(changes).some(
          (changeKey) => !noRefetchKeys.includes(changeKey as keyof DashboardContainerInput)
        );
        if (getSearchSessionIdFromURL(history)) {
          // going away from a background search results
          removeQueryParam(history, DashboardConstants.SEARCH_SESSION_ID, true);
        }

        if (changes.viewMode) {
          setViewMode(changes.viewMode);
        }

        dashboardContainer.updateInput({
          ...changes,
          // do not start a new session if this is irrelevant state change to prevent excessive searches
          ...(shouldRefetch && { searchSessionId: data.search.session.start() }),
        });
      }
    },
    [
      history,
      data.query,
      setViewMode,
      embedSettings,
      dashboardContainer,
      data.search.session,
      dashboardCapabilities,
      dashboardStateManager,
    ]
  );

  // Manage dashboard container subscriptions
  useEffect(() => {
    if (!dashboardStateManager || !dashboardContainer) {
      return;
    }
    const timeFilter = data.query.timefilter.timefilter;
    const subscriptions = new Subscription();

    subscriptions.add(
      getInputSubscription({
        dashboardContainer,
        dashboardStateManager,
        filterManager: data.query.filterManager,
      })
    );
    subscriptions.add(
      getOutputSubscription({
        dashboardContainer,
        indexPatterns: indexPatternService,
        onUpdateIndexPatterns: (newIndexPatterns) => setIndexPatterns(newIndexPatterns),
      })
    );
    subscriptions.add(
      getFiltersSubscription({
        query: data.query,
        dashboardStateManager,
      })
    );
    subscriptions.add(
      merge(
        ...[timeFilter.getRefreshIntervalUpdate$(), timeFilter.getTimeUpdate$()]
      ).subscribe(() => refreshDashboardContainer())
    );
    subscriptions.add(
      data.search.session.onRefresh$.subscribe(() => {
        setLastReloadTime(() => new Date().getTime());
      })
    );
    dashboardStateManager.registerChangeListener(() => {
      // we aren't checking dirty state because there are changes the container needs to know about
      // that won't make the dashboard "dirty" - like a view mode change.
      refreshDashboardContainer();
    });

    return () => {
      subscriptions.unsubscribe();
    };
  }, [
    core.http,
    uiSettings,
    data.query,
    dashboardContainer,
    data.search.session,
    indexPatternService,
    dashboardStateManager,
    refreshDashboardContainer,
  ]);

  // Sync breadcrumbs when Dashboard State Manager changes
  useDashboardBreadcrumbs(dashboardStateManager, redirectTo);

  // Build onAppLeave when Dashboard State Manager changes
  useEffect(() => {
    if (!dashboardStateManager || !dashboardContainer) {
      return;
    }
    onAppLeave((actions) => {
      if (dashboardStateManager?.getIsDirty()) {
        // TODO: Finish App leave handler with overrides when redirecting to an editor.
        // return actions.confirm(leaveConfirmStrings.leaveSubtitle, leaveConfirmStrings.leaveTitle);
      }
      return actions.default();
    });
    return () => {
      // reset on app leave handler so leaving from the listing page doesn't trigger a confirmation
      onAppLeave((actions) => actions.default());
    };
  }, [dashboardStateManager, dashboardContainer, onAppLeave]);

  // Refresh the dashboard container when lastReloadTime changes
  useEffect(() => {
    refreshDashboardContainer(lastReloadTime);
  }, [lastReloadTime, refreshDashboardContainer]);

  return (
    <div className="app-container dshAppContainer">
      {savedDashboard && dashboardStateManager && dashboardContainer && viewMode && (
        <>
          <DashboardTopNav
            {...{
              redirectTo,
              embedSettings,
              indexPatterns,
              savedDashboard,
              dashboardContainer,
              dashboardStateManager,
            }}
            viewMode={viewMode}
            lastDashboardId={savedDashboardId}
            timefilter={data.query.timefilter.timefilter}
            onQuerySubmit={(_payload, isUpdate) => {
              if (isUpdate === false) {
                // The user can still request a reload in the query bar, even if the
                // query is the same, and in that case, we have to explicitly ask for
                // a reload, since no state changes will cause it.
                setLastReloadTime(() => new Date().getTime());
              }
            }}
          />
          <div className="dashboardViewport">
            <EmbeddableRenderer embeddable={dashboardContainer} />
          </div>
        </>
      )}
    </div>
  );
}
