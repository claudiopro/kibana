/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { cloneDeep } from 'lodash';
import {
  KibanaRequest,
  Logger,
  SavedObject,
  SavedObjectsClientContract,
  SavedObjectsFindResponse,
  SavedObjectsBulkResponse,
  SavedObjectsFindResult,
} from 'kibana/server';

import { nodeBuilder, KueryNode } from '../../../../../../src/plugins/data/common';

import { SecurityPluginSetup } from '../../../../security/server';
import {
  ESCaseAttributes,
  CommentAttributes,
  User,
  SubCaseAttributes,
  AssociationType,
  SubCaseResponse,
  CommentType,
  CaseType,
  CaseResponse,
  caseTypeField,
  CasesFindRequest,
  CaseStatuses,
} from '../../../common/api';
import {
  defaultSortField,
  flattenCaseSavedObject,
  flattenSubCaseSavedObject,
  groupTotalAlertsByID,
  SavedObjectFindOptionsKueryNode,
} from '../../common';
import { ENABLE_CASE_CONNECTOR } from '../../../common/constants';
import { defaultPage, defaultPerPage } from '../../routes/api';
import {
  CASE_SAVED_OBJECT,
  CASE_COMMENT_SAVED_OBJECT,
  SUB_CASE_SAVED_OBJECT,
} from '../../../common/constants';
import { readReporters } from './read_reporters';
import { readTags } from './read_tags';
import { ClientArgs } from '..';

interface PushedArgs {
  pushed_at: string;
  pushed_by: User;
}

interface GetCaseArgs extends ClientArgs {
  id: string;
}

interface GetCasesArgs extends ClientArgs {
  caseIds: string[];
}

interface GetSubCasesArgs extends ClientArgs {
  ids: string[];
}

interface FindCommentsArgs {
  soClient: SavedObjectsClientContract;
  id: string | string[];
  options?: SavedObjectFindOptionsKueryNode;
}

interface FindCaseCommentsArgs {
  soClient: SavedObjectsClientContract;
  id: string | string[];
  options?: SavedObjectFindOptionsKueryNode;
  includeSubCaseComments?: boolean;
}

interface FindSubCaseCommentsArgs {
  soClient: SavedObjectsClientContract;
  id: string | string[];
  options?: SavedObjectFindOptionsKueryNode;
}

interface FindCasesArgs extends ClientArgs {
  options?: SavedObjectFindOptionsKueryNode;
}

interface FindSubCasesByIDArgs extends FindCasesArgs {
  ids: string[];
}

interface FindSubCasesStatusStats {
  soClient: SavedObjectsClientContract;
  options: SavedObjectFindOptionsKueryNode;
  ids: string[];
}

interface PostCaseArgs extends ClientArgs {
  attributes: ESCaseAttributes;
  id: string;
}

interface CreateSubCaseArgs extends ClientArgs {
  createdAt: string;
  caseId: string;
  createdBy: User;
}

interface PatchCase {
  caseId: string;
  updatedAttributes: Partial<ESCaseAttributes & PushedArgs>;
  version?: string;
}
type PatchCaseArgs = PatchCase & ClientArgs;

interface PatchCasesArgs extends ClientArgs {
  cases: PatchCase[];
}

interface PatchSubCase {
  soClient: SavedObjectsClientContract;
  subCaseId: string;
  updatedAttributes: Partial<SubCaseAttributes>;
  version?: string;
}

interface PatchSubCases {
  soClient: SavedObjectsClientContract;
  subCases: Array<Omit<PatchSubCase, 'soClient'>>;
}

interface GetUserArgs {
  request: KibanaRequest;
}

interface SubCasesMapWithPageInfo {
  subCasesMap: Map<string, SubCaseResponse[]>;
  page: number;
  perPage: number;
  total: number;
}

interface CaseCommentStats {
  commentTotals: Map<string, number>;
  alertTotals: Map<string, number>;
}

interface FindCommentsByAssociationArgs {
  soClient: SavedObjectsClientContract;
  id: string | string[];
  associationType: AssociationType;
  options?: SavedObjectFindOptionsKueryNode;
}

interface Collection {
  case: SavedObjectsFindResult<ESCaseAttributes>;
  subCases?: SubCaseResponse[];
}

interface CasesMapWithPageInfo {
  casesMap: Map<string, CaseResponse>;
  page: number;
  perPage: number;
  total: number;
}

type FindCaseOptions = CasesFindRequest & SavedObjectFindOptionsKueryNode;

const transformNewSubCase = ({
  createdAt,
  createdBy,
}: {
  createdAt: string;
  createdBy: User;
}): SubCaseAttributes => {
  return {
    closed_at: null,
    closed_by: null,
    created_at: createdAt,
    created_by: createdBy,
    status: CaseStatuses.open,
    updated_at: null,
    updated_by: null,
  };
};

export class CaseService {
  constructor(
    private readonly log: Logger,
    private readonly authentication?: SecurityPluginSetup['authc']
  ) {}

  /**
   * Returns a map of all cases combined with their sub cases if they are collections.
   */
  public async findCasesGroupedByID({
    soClient,
    caseOptions,
    subCaseOptions,
  }: {
    soClient: SavedObjectsClientContract;
    caseOptions: FindCaseOptions;
    subCaseOptions?: SavedObjectFindOptionsKueryNode;
  }): Promise<CasesMapWithPageInfo> {
    const cases = await this.findCases({
      soClient,
      options: caseOptions,
    });

    const subCasesResp = ENABLE_CASE_CONNECTOR
      ? await this.findSubCasesGroupByCase({
          soClient,
          options: subCaseOptions,
          ids: cases.saved_objects
            .filter((caseInfo) => caseInfo.attributes.type === CaseType.collection)
            .map((caseInfo) => caseInfo.id),
        })
      : { subCasesMap: new Map<string, SubCaseResponse[]>(), page: 0, perPage: 0 };

    const casesMap = cases.saved_objects.reduce((accMap, caseInfo) => {
      const subCasesForCase = subCasesResp.subCasesMap.get(caseInfo.id);

      /**
       * If this case is an individual add it to the return map
       * If it is a collection and it has sub cases add it to the return map
       * If it is a collection and it does not have sub cases, check and see if we're filtering on a status,
       *  if we're filtering on a status then exclude the empty collection from the results
       *  if we're not filtering on a status then include the empty collection (that way we can display all the collections
       *  when the UI isn't doing any filtering)
       */
      if (
        caseInfo.attributes.type === CaseType.individual ||
        subCasesForCase !== undefined ||
        !caseOptions.status
      ) {
        accMap.set(caseInfo.id, { case: caseInfo, subCases: subCasesForCase });
      }
      return accMap;
    }, new Map<string, Collection>());

    /**
     * One potential optimization here is to get all comment stats for individual cases, parent cases, and sub cases
     * in a single request. This can be done because comments that are for sub cases have a reference to both the sub case
     * and the parent. The associationType field allows us to determine which type of case the comment is attached to.
     *
     * So we could use the ids for all the valid cases (individual cases and parents with sub cases) to grab everything.
     * Once we have it we can build the maps.
     *
     * Currently we get all comment stats for all sub cases in one go and we get all comment stats for cases (individual and parent)
     * in another request (the one below this comment).
     */
    const totalCommentsForCases = await this.getCaseCommentStats({
      soClient,
      ids: Array.from(casesMap.keys()),
      associationType: AssociationType.case,
    });

    const casesWithComments = new Map<string, CaseResponse>();
    for (const [id, caseInfo] of casesMap.entries()) {
      casesWithComments.set(
        id,
        flattenCaseSavedObject({
          savedObject: caseInfo.case,
          totalComment: totalCommentsForCases.commentTotals.get(id) ?? 0,
          totalAlerts: totalCommentsForCases.alertTotals.get(id) ?? 0,
          subCases: caseInfo.subCases,
        })
      );
    }

    return {
      casesMap: casesWithComments,
      page: cases.page,
      perPage: cases.per_page,
      total: cases.total,
    };
  }

  /**
   * Retrieves the number of cases that exist with a given status (open, closed, etc).
   * This also counts sub cases. Parent cases are excluded from the statistics.
   */
  public async findCaseStatusStats({
    soClient,
    caseOptions,
    subCaseOptions,
  }: {
    soClient: SavedObjectsClientContract;
    caseOptions: SavedObjectFindOptionsKueryNode;
    subCaseOptions?: SavedObjectFindOptionsKueryNode;
  }): Promise<number> {
    const casesStats = await this.findCases({
      soClient,
      options: {
        ...caseOptions,
        fields: [],
        page: 1,
        perPage: 1,
      },
    });

    /**
     * This could be made more performant. What we're doing here is retrieving all cases
     * that match the API request's filters instead of just counts. This is because we need to grab
     * the ids for the parent cases that match those filters. Then we use those IDS to count how many
     * sub cases those parents have to calculate the total amount of cases that are open, closed, or in-progress.
     *
     * Another solution would be to store ALL filterable fields on both a case and sub case. That we could do a single
     * query for each type to calculate the totals using the filters. This has drawbacks though:
     *
     * We'd have to sync up the parent case's editable attributes with the sub case any time they were change to avoid
     * them getting out of sync and causing issues when we do these types of stats aggregations. This would result in a lot
     * of update requests if the user is editing their case details often. Which could potentially cause conflict failures.
     *
     * Another option is to prevent the ability from update the parent case's details all together once it's created. A user
     * could instead modify the sub case details directly. This could be weird though because individual sub cases for the same
     * parent would have different titles, tags, etc.
     *
     * Another potential issue with this approach is when you push a case and all its sub case information. If the sub cases
     * don't have the same title and tags, we'd need to account for that as well.
     */
    const cases = await this.findCases({
      soClient,
      options: {
        ...caseOptions,
        fields: [caseTypeField],
        page: 1,
        perPage: casesStats.total,
      },
    });

    const caseIds = cases.saved_objects
      .filter((caseInfo) => caseInfo.attributes.type === CaseType.collection)
      .map((caseInfo) => caseInfo.id);

    let subCasesTotal = 0;

    if (ENABLE_CASE_CONNECTOR && subCaseOptions) {
      subCasesTotal = await this.findSubCaseStatusStats({
        soClient,
        options: cloneDeep(subCaseOptions),
        ids: caseIds,
      });
    }

    const total =
      cases.saved_objects.filter((caseInfo) => caseInfo.attributes.type !== CaseType.collection)
        .length + subCasesTotal;

    return total;
  }

  /**
   * Retrieves the comments attached to a case or sub case.
   */
  public async getCommentsByAssociation({
    soClient,
    id,
    associationType,
    options,
  }: FindCommentsByAssociationArgs): Promise<SavedObjectsFindResponse<CommentAttributes>> {
    if (associationType === AssociationType.subCase) {
      return this.getAllSubCaseComments({
        soClient,
        id,
        options,
      });
    } else {
      return this.getAllCaseComments({
        soClient,
        id,
        options,
      });
    }
  }

  /**
   * Returns the number of total comments and alerts for a case (or sub case)
   */
  public async getCaseCommentStats({
    soClient,
    ids,
    associationType,
  }: {
    soClient: SavedObjectsClientContract;
    ids: string[];
    associationType: AssociationType;
  }): Promise<CaseCommentStats> {
    if (ids.length <= 0) {
      return {
        commentTotals: new Map<string, number>(),
        alertTotals: new Map<string, number>(),
      };
    }

    const refType =
      associationType === AssociationType.case ? CASE_SAVED_OBJECT : SUB_CASE_SAVED_OBJECT;

    const allComments = await Promise.all(
      ids.map((id) =>
        this.getCommentsByAssociation({
          soClient,
          associationType,
          id,
          options: { page: 1, perPage: 1 },
        })
      )
    );

    const alerts = await this.getCommentsByAssociation({
      soClient,
      associationType,
      id: ids,
      options: {
        filter: nodeBuilder.or([
          nodeBuilder.is(`${CASE_COMMENT_SAVED_OBJECT}.attributes.type`, CommentType.alert),
          nodeBuilder.is(
            `${CASE_COMMENT_SAVED_OBJECT}.attributes.type`,
            CommentType.generatedAlert
          ),
        ]),
      },
    });

    const getID = (comments: SavedObjectsFindResponse<unknown>) => {
      return comments.saved_objects.length > 0
        ? comments.saved_objects[0].references.find((ref) => ref.type === refType)?.id
        : undefined;
    };

    const groupedComments = allComments.reduce((acc, comments) => {
      const id = getID(comments);
      if (id) {
        acc.set(id, comments.total);
      }
      return acc;
    }, new Map<string, number>());

    const groupedAlerts = groupTotalAlertsByID({ comments: alerts });
    return { commentTotals: groupedComments, alertTotals: groupedAlerts };
  }

  /**
   * Returns all the sub cases for a set of case IDs. Comment statistics are also returned.
   */
  public async findSubCasesGroupByCase({
    soClient,
    options,
    ids,
  }: {
    soClient: SavedObjectsClientContract;
    options?: SavedObjectFindOptionsKueryNode;
    ids: string[];
  }): Promise<SubCasesMapWithPageInfo> {
    const getCaseID = (subCase: SavedObjectsFindResult<SubCaseAttributes>): string | undefined => {
      return subCase.references.length > 0 ? subCase.references[0].id : undefined;
    };

    const emptyResponse = {
      subCasesMap: new Map<string, SubCaseResponse[]>(),
      page: 0,
      perPage: 0,
      total: 0,
    };

    if (!options) {
      return emptyResponse;
    }

    if (ids.length <= 0) {
      return emptyResponse;
    }

    const subCases = await this.findSubCases({
      soClient,
      options: {
        ...options,
        hasReference: ids.map((id) => {
          return {
            id,
            type: CASE_SAVED_OBJECT,
          };
        }),
      },
    });

    const subCaseComments = await this.getCaseCommentStats({
      soClient,
      ids: subCases.saved_objects.map((subCase) => subCase.id),
      associationType: AssociationType.subCase,
    });

    const subCasesMap = subCases.saved_objects.reduce((accMap, subCase) => {
      const parentCaseID = getCaseID(subCase);
      if (parentCaseID) {
        const subCaseFromMap = accMap.get(parentCaseID);

        if (subCaseFromMap === undefined) {
          const subCasesForID = [
            flattenSubCaseSavedObject({
              savedObject: subCase,
              totalComment: subCaseComments.commentTotals.get(subCase.id) ?? 0,
              totalAlerts: subCaseComments.alertTotals.get(subCase.id) ?? 0,
            }),
          ];
          accMap.set(parentCaseID, subCasesForID);
        } else {
          subCaseFromMap.push(
            flattenSubCaseSavedObject({
              savedObject: subCase,
              totalComment: subCaseComments.commentTotals.get(subCase.id) ?? 0,
              totalAlerts: subCaseComments.alertTotals.get(subCase.id) ?? 0,
            })
          );
        }
      }
      return accMap;
    }, new Map<string, SubCaseResponse[]>());

    return { subCasesMap, page: subCases.page, perPage: subCases.per_page, total: subCases.total };
  }

  /**
   * Calculates the number of sub cases for a given set of options for a set of case IDs.
   */
  public async findSubCaseStatusStats({
    soClient,
    options,
    ids,
  }: FindSubCasesStatusStats): Promise<number> {
    if (ids.length <= 0) {
      return 0;
    }

    const subCases = await this.findSubCases({
      soClient,
      options: {
        ...options,
        page: 1,
        perPage: 1,
        fields: [],
        hasReference: ids.map((id) => {
          return {
            id,
            type: CASE_SAVED_OBJECT,
          };
        }),
      },
    });

    return subCases.total;
  }

  public async createSubCase({
    soClient,
    createdAt,
    caseId,
    createdBy,
  }: CreateSubCaseArgs): Promise<SavedObject<SubCaseAttributes>> {
    try {
      this.log.debug(`Attempting to POST a new sub case`);
      return soClient.create<SubCaseAttributes>(
        SUB_CASE_SAVED_OBJECT,
        transformNewSubCase({ createdAt, createdBy }),
        {
          references: [
            {
              type: CASE_SAVED_OBJECT,
              name: `associated-${CASE_SAVED_OBJECT}`,
              id: caseId,
            },
          ],
        }
      );
    } catch (error) {
      this.log.error(`Error on POST a new sub case for id ${caseId}: ${error}`);
      throw error;
    }
  }

  public async getMostRecentSubCase(soClient: SavedObjectsClientContract, caseId: string) {
    try {
      this.log.debug(`Attempting to find most recent sub case for caseID: ${caseId}`);
      const subCases = await soClient.find<SubCaseAttributes>({
        perPage: 1,
        sortField: 'created_at',
        sortOrder: 'desc',
        type: SUB_CASE_SAVED_OBJECT,
        hasReference: { type: CASE_SAVED_OBJECT, id: caseId },
      });
      if (subCases.saved_objects.length <= 0) {
        return;
      }

      return subCases.saved_objects[0];
    } catch (error) {
      this.log.error(`Error finding the most recent sub case for case: ${caseId}: ${error}`);
      throw error;
    }
  }

  public async deleteSubCase(soClient: SavedObjectsClientContract, id: string) {
    try {
      this.log.debug(`Attempting to DELETE sub case ${id}`);
      return await soClient.delete(SUB_CASE_SAVED_OBJECT, id);
    } catch (error) {
      this.log.error(`Error on DELETE sub case ${id}: ${error}`);
      throw error;
    }
  }

  public async deleteCase({ soClient, id: caseId }: GetCaseArgs) {
    try {
      this.log.debug(`Attempting to DELETE case ${caseId}`);
      return await soClient.delete(CASE_SAVED_OBJECT, caseId);
    } catch (error) {
      this.log.error(`Error on DELETE case ${caseId}: ${error}`);
      throw error;
    }
  }

  public async getCase({
    soClient,
    id: caseId,
  }: GetCaseArgs): Promise<SavedObject<ESCaseAttributes>> {
    try {
      this.log.debug(`Attempting to GET case ${caseId}`);
      return await soClient.get<ESCaseAttributes>(CASE_SAVED_OBJECT, caseId);
    } catch (error) {
      this.log.error(`Error on GET case ${caseId}: ${error}`);
      throw error;
    }
  }
  public async getSubCase({ soClient, id }: GetCaseArgs): Promise<SavedObject<SubCaseAttributes>> {
    try {
      this.log.debug(`Attempting to GET sub case ${id}`);
      return await soClient.get<SubCaseAttributes>(SUB_CASE_SAVED_OBJECT, id);
    } catch (error) {
      this.log.error(`Error on GET sub case ${id}: ${error}`);
      throw error;
    }
  }

  public async getSubCases({
    soClient,
    ids,
  }: GetSubCasesArgs): Promise<SavedObjectsBulkResponse<SubCaseAttributes>> {
    try {
      this.log.debug(`Attempting to GET sub cases ${ids.join(', ')}`);
      return await soClient.bulkGet<SubCaseAttributes>(
        ids.map((id) => ({ type: SUB_CASE_SAVED_OBJECT, id }))
      );
    } catch (error) {
      this.log.error(`Error on GET cases ${ids.join(', ')}: ${error}`);
      throw error;
    }
  }

  public async getCases({
    soClient,
    caseIds,
  }: GetCasesArgs): Promise<SavedObjectsBulkResponse<ESCaseAttributes>> {
    try {
      this.log.debug(`Attempting to GET cases ${caseIds.join(', ')}`);
      return await soClient.bulkGet<ESCaseAttributes>(
        caseIds.map((caseId) => ({ type: CASE_SAVED_OBJECT, id: caseId }))
      );
    } catch (error) {
      this.log.error(`Error on GET cases ${caseIds.join(', ')}: ${error}`);
      throw error;
    }
  }

  public async findCases({
    soClient,
    options,
  }: FindCasesArgs): Promise<SavedObjectsFindResponse<ESCaseAttributes>> {
    try {
      this.log.debug(`Attempting to find cases`);
      return await soClient.find<ESCaseAttributes>({
        sortField: defaultSortField,
        ...cloneDeep(options),
        type: CASE_SAVED_OBJECT,
      });
    } catch (error) {
      this.log.error(`Error on find cases: ${error}`);
      throw error;
    }
  }

  public async findSubCases({
    soClient,
    options,
  }: FindCasesArgs): Promise<SavedObjectsFindResponse<SubCaseAttributes>> {
    try {
      this.log.debug(`Attempting to find sub cases`);
      // if the page or perPage options are set then respect those instead of trying to
      // grab all sub cases
      if (options?.page !== undefined || options?.perPage !== undefined) {
        return soClient.find<SubCaseAttributes>({
          sortField: defaultSortField,
          ...cloneDeep(options),
          type: SUB_CASE_SAVED_OBJECT,
        });
      }

      const stats = await soClient.find<SubCaseAttributes>({
        fields: [],
        page: 1,
        perPage: 1,
        sortField: defaultSortField,
        ...cloneDeep(options),
        type: SUB_CASE_SAVED_OBJECT,
      });
      return soClient.find<SubCaseAttributes>({
        page: 1,
        perPage: stats.total,
        sortField: defaultSortField,
        ...cloneDeep(options),
        type: SUB_CASE_SAVED_OBJECT,
      });
    } catch (error) {
      this.log.error(`Error on find sub cases: ${error}`);
      throw error;
    }
  }

  /**
   * Find sub cases using a collection's ID. This would try to retrieve the maximum amount of sub cases
   * by default.
   *
   * @param id the saved object ID of the parent collection to find sub cases for.
   */
  public async findSubCasesByCaseId({
    soClient,
    ids,
    options,
  }: FindSubCasesByIDArgs): Promise<SavedObjectsFindResponse<SubCaseAttributes>> {
    if (ids.length <= 0) {
      return {
        total: 0,
        saved_objects: [],
        page: options?.page ?? defaultPage,
        per_page: options?.perPage ?? defaultPerPage,
      };
    }

    try {
      this.log.debug(`Attempting to GET sub cases for case collection id ${ids.join(', ')}`);
      return this.findSubCases({
        soClient,
        options: {
          ...options,
          hasReference: ids.map((id) => ({
            type: CASE_SAVED_OBJECT,
            id,
          })),
        },
      });
    } catch (error) {
      this.log.error(
        `Error on GET all sub cases for case collection id ${ids.join(', ')}: ${error}`
      );
      throw error;
    }
  }

  private asArray(id: string | string[] | undefined): string[] {
    if (id === undefined) {
      return [];
    } else if (Array.isArray(id)) {
      return id;
    } else {
      return [id];
    }
  }

  private async getAllComments({
    soClient,
    id,
    options,
  }: FindCommentsArgs): Promise<SavedObjectsFindResponse<CommentAttributes>> {
    try {
      this.log.debug(`Attempting to GET all comments for id ${JSON.stringify(id)}`);
      if (options?.page !== undefined || options?.perPage !== undefined) {
        return soClient.find<CommentAttributes>({
          type: CASE_COMMENT_SAVED_OBJECT,
          sortField: defaultSortField,
          ...cloneDeep(options),
        });
      }
      // get the total number of comments that are in ES then we'll grab them all in one go
      const stats = await soClient.find<CommentAttributes>({
        type: CASE_COMMENT_SAVED_OBJECT,
        fields: [],
        page: 1,
        perPage: 1,
        sortField: defaultSortField,
        // spread the options after so the caller can override the default behavior if they want
        ...cloneDeep(options),
      });

      return soClient.find<CommentAttributes>({
        type: CASE_COMMENT_SAVED_OBJECT,
        page: 1,
        perPage: stats.total,
        sortField: defaultSortField,
        ...cloneDeep(options),
      });
    } catch (error) {
      this.log.error(`Error on GET all comments for ${JSON.stringify(id)}: ${error}`);
      throw error;
    }
  }

  /**
   * Default behavior is to retrieve all comments that adhere to a given filter (if one is included).
   * to override this pass in the either the page or perPage options.
   *
   * @param includeSubCaseComments is a flag to indicate that sub case comments should be included as well, by default
   *  sub case comments are excluded. If the `filter` field is included in the options, it will override this behavior
   */
  public async getAllCaseComments({
    soClient,
    id,
    options,
    includeSubCaseComments = false,
  }: FindCaseCommentsArgs): Promise<SavedObjectsFindResponse<CommentAttributes>> {
    try {
      const refs = this.asArray(id).map((caseID) => ({ type: CASE_SAVED_OBJECT, id: caseID }));
      if (refs.length <= 0) {
        return {
          saved_objects: [],
          total: 0,
          per_page: options?.perPage ?? defaultPerPage,
          page: options?.page ?? defaultPage,
        };
      }

      let filter: KueryNode | undefined;
      if (!includeSubCaseComments) {
        // if other filters were passed in then combine them to filter out sub case comments
        const associationTypeFilter = nodeBuilder.is(
          `${CASE_COMMENT_SAVED_OBJECT}.attributes.associationType`,
          AssociationType.case
        );

        filter =
          options?.filter != null
            ? nodeBuilder.and([options.filter, associationTypeFilter])
            : associationTypeFilter;
      }

      this.log.debug(`Attempting to GET all comments for case caseID ${JSON.stringify(id)}`);
      return this.getAllComments({
        soClient,
        id,
        options: {
          hasReferenceOperator: 'OR',
          hasReference: refs,
          filter,
          ...options,
        },
      });
    } catch (error) {
      this.log.error(`Error on GET all comments for case ${JSON.stringify(id)}: ${error}`);
      throw error;
    }
  }

  public async getAllSubCaseComments({
    soClient,
    id,
    options,
  }: FindSubCaseCommentsArgs): Promise<SavedObjectsFindResponse<CommentAttributes>> {
    try {
      const refs = this.asArray(id).map((caseID) => ({ type: SUB_CASE_SAVED_OBJECT, id: caseID }));
      if (refs.length <= 0) {
        return {
          saved_objects: [],
          total: 0,
          per_page: options?.perPage ?? defaultPerPage,
          page: options?.page ?? defaultPage,
        };
      }

      this.log.debug(`Attempting to GET all comments for sub case caseID ${JSON.stringify(id)}`);
      return this.getAllComments({
        soClient,
        id,
        options: {
          hasReferenceOperator: 'OR',
          hasReference: refs,
          ...options,
        },
      });
    } catch (error) {
      this.log.error(`Error on GET all comments for sub case ${JSON.stringify(id)}: ${error}`);
      throw error;
    }
  }

  public async getReporters({ soClient }: ClientArgs) {
    try {
      this.log.debug(`Attempting to GET all reporters`);
      return await readReporters({ soClient });
    } catch (error) {
      this.log.error(`Error on GET all reporters: ${error}`);
      throw error;
    }
  }
  public async getTags({ soClient }: ClientArgs) {
    try {
      this.log.debug(`Attempting to GET all cases`);
      return await readTags({ soClient });
    } catch (error) {
      this.log.error(`Error on GET cases: ${error}`);
      throw error;
    }
  }

  public getUser({ request }: GetUserArgs) {
    try {
      this.log.debug(`Attempting to authenticate a user`);
      if (this.authentication != null) {
        const user = this.authentication.getCurrentUser(request);
        if (!user) {
          return {
            username: null,
            full_name: null,
            email: null,
          };
        }
        return user;
      }
      return {
        username: null,
        full_name: null,
        email: null,
      };
    } catch (error) {
      this.log.error(`Error on GET cases: ${error}`);
      throw error;
    }
  }

  public async postNewCase({ soClient, attributes, id }: PostCaseArgs) {
    try {
      this.log.debug(`Attempting to POST a new case`);
      return await soClient.create<ESCaseAttributes>(CASE_SAVED_OBJECT, attributes, { id });
    } catch (error) {
      this.log.error(`Error on POST a new case: ${error}`);
      throw error;
    }
  }

  public async patchCase({ soClient, caseId, updatedAttributes, version }: PatchCaseArgs) {
    try {
      this.log.debug(`Attempting to UPDATE case ${caseId}`);
      return await soClient.update<ESCaseAttributes>(
        CASE_SAVED_OBJECT,
        caseId,
        { ...updatedAttributes },
        { version }
      );
    } catch (error) {
      this.log.error(`Error on UPDATE case ${caseId}: ${error}`);
      throw error;
    }
  }

  public async patchCases({ soClient, cases }: PatchCasesArgs) {
    try {
      this.log.debug(`Attempting to UPDATE case ${cases.map((c) => c.caseId).join(', ')}`);
      return await soClient.bulkUpdate<ESCaseAttributes>(
        cases.map((c) => ({
          type: CASE_SAVED_OBJECT,
          id: c.caseId,
          attributes: c.updatedAttributes,
          version: c.version,
        }))
      );
    } catch (error) {
      this.log.error(`Error on UPDATE case ${cases.map((c) => c.caseId).join(', ')}: ${error}`);
      throw error;
    }
  }

  public async patchSubCase({ soClient, subCaseId, updatedAttributes, version }: PatchSubCase) {
    try {
      this.log.debug(`Attempting to UPDATE sub case ${subCaseId}`);
      return await soClient.update<SubCaseAttributes>(
        SUB_CASE_SAVED_OBJECT,
        subCaseId,
        { ...updatedAttributes },
        { version }
      );
    } catch (error) {
      this.log.error(`Error on UPDATE sub case ${subCaseId}: ${error}`);
      throw error;
    }
  }

  public async patchSubCases({ soClient, subCases }: PatchSubCases) {
    try {
      this.log.debug(
        `Attempting to UPDATE sub case ${subCases.map((c) => c.subCaseId).join(', ')}`
      );
      return await soClient.bulkUpdate<SubCaseAttributes>(
        subCases.map((c) => ({
          type: SUB_CASE_SAVED_OBJECT,
          id: c.subCaseId,
          attributes: c.updatedAttributes,
          version: c.version,
        }))
      );
    } catch (error) {
      this.log.error(
        `Error on UPDATE sub case ${subCases.map((c) => c.subCaseId).join(', ')}: ${error}`
      );
      throw error;
    }
  }
}
