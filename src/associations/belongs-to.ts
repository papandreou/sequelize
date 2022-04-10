import upperFirst from 'lodash/upperFirst';
import type { DataType } from '../data-types.js';
import type {
  ModelStatic,
  Model,
  CreateOptions,
  CreationAttributes,
  FindOptions,
  SaveOptions,
  AttributeNames,
} from '../model';
import { Op } from '../operators';
import * as Utils from '../utils';
import type { AssociationOptions, SingleAssociationAccessors } from './base';
import { Association } from './base';
import type { NormalizeBaseAssociationOptions } from './helpers';
import {
  addForeignKeyConstraints,
  defineAssociation,
  mixinMethods, normalizeBaseAssociationOptions,
} from './helpers';

// TODO: strictly type mixin options

/**
 * One-to-one association
 * See {@link Model.belongsTo}
 *
 * This is almost the same as {@link HasOne}, but the foreign key will be defined on the source model.
 *
 * In the API reference below, add the name of the association to the method, e.g. for `User.belongsTo(Project)` the getter will be `user.getProject()`.
 *
 * @typeParam S The model on which {@link Model.belongsTo} has been called, on which the association methods, as well as the foreign key attribute, will be added.
 * @typeParam T The model passed to {@link Model.belongsTo}.
 * @typeParam SourceKey The name of the Foreign Key attribute on the Source model.
 * @typeParam TargetKey The name of the attribute that the foreign key in the source model will reference, typically the Primary Key.
 */
export class BelongsTo<
  S extends Model = Model,
  T extends Model = Model,
  SourceKey extends AttributeNames<S> = any,
  TargetKey extends AttributeNames<T> = any,
> extends Association<S, T, SourceKey, NormalizedBelongsToOptions<SourceKey, TargetKey>> {

  readonly accessors: SingleAssociationAccessors;

  /**
   * The attribute name of the identifier
   *
   * @deprecated use {@link foreignKey} instead
   */
  get identifier(): string {
    return this.foreignKey;
  }

  /**
   * The column name of the identifier
   */
  identifierField: string | undefined;

  /**
   * The name of the attribute the foreign key points to.
   * In belongsTo, this key is on the Target Model, instead of the Source Model  (unlike {@link HasOne.sourceKey}).
   * The {@link Association.foreignKey} is on the Source Model.
   */
  get targetKey(): TargetKey {
    return this.attributeReferencedByForeignKey as TargetKey;
  }

  /**
   * The column name of the target key
   */
  readonly targetKeyField: string;

  readonly targetKeyIsPrimary: boolean;

  /**
   * @deprecated use {@link BelongsTo.targetKey}
   */
  get targetIdentifier(): string {
    return this.targetKey;
  }

  constructor(
    secret: symbol,
    source: ModelStatic<S>,
    target: ModelStatic<T>,
    options: NormalizedBelongsToOptions<SourceKey, TargetKey>,
    parent?: Association,
  ) {
    if (
      options?.targetKey
      && !target.getAttributes()[options.targetKey]
    ) {
      throw new Error(`Unknown attribute "${options.targetKey}" passed as targetKey, define this attribute on model "${target.name}" first`);
    }

    // TODO: throw is source model has a composite primary key.
    const attributeReferencedByForeignKey = options?.targetKey || (target.primaryKeyAttribute as TargetKey);

    super(secret, source, target, attributeReferencedByForeignKey, options, parent);

    this._origOptions = options;
    this.computeForeignKey();

    if (this.source.getAttributes()[this.foreignKey]) {
      this.identifierField = Utils.getColumnName(this.source.getAttributes()[this.foreignKey]);
    }

    this.targetKeyField = Utils.getColumnName(this.target.getAttributes()[this.targetKey]);
    this.targetKeyIsPrimary = this.targetKey === this.target.primaryKeyAttribute;

    // Get singular name, trying to uppercase the first letter, unless the model forbids it
    const singular = upperFirst(this.options.name.singular);

    this.accessors = {
      get: `get${singular}`,
      set: `set${singular}`,
      create: `create${singular}`,
    };

    this.#injectAttributes();
    this.#mixin(source.prototype);
  }

  static associate<
    S extends Model,
    T extends Model,
    SourceKey extends AttributeNames<S>,
    TargetKey extends AttributeNames<T>,
    >(
    secret: symbol,
    source: ModelStatic<S>,
    target: ModelStatic<T>,
    options: BelongsToOptions<SourceKey, TargetKey> = {},
    parent?: Association<any>,
  ): BelongsTo<S, T, SourceKey, TargetKey> {
    return defineAssociation<
      BelongsTo<S, T, SourceKey, TargetKey>,
      BelongsToOptions<SourceKey, TargetKey>,
      NormalizedBelongsToOptions<SourceKey, TargetKey>
    >(BelongsTo, source, target, options, parent, normalizeBaseAssociationOptions, normalizedOptions => {
      return new BelongsTo(secret, source, target, normalizedOptions, parent);
    });
  }

  // the id is in the source table
  #injectAttributes() {
    const newAttributes = {
      [this.foreignKey]: {
        type: this.options.keyType || this.target.rawAttributes[this.targetKey].type,
        allowNull: true,
        ...this.foreignKeyAttribute,
      },
    };

    if (this.options.constraints !== false) {
      const source = this.source.rawAttributes[this.foreignKey] || newAttributes[this.foreignKey];
      this.options.onDelete = this.options.onDelete || (source.allowNull ? 'SET NULL' : 'NO ACTION');
      this.options.onUpdate = this.options.onUpdate || 'CASCADE';
    }

    addForeignKeyConstraints(newAttributes[this.foreignKey], this.target, this.options, this.targetKeyField);

    this.source.mergeAttributesDefault(newAttributes);

    this.identifierField = Utils.getColumnName(this.source.rawAttributes[this.foreignKey]);

    return this;
  }

  #mixin(modelPrototype: Model): void {
    mixinMethods(this, modelPrototype, ['get', 'set', 'create']);
  }

  protected inferForeignKey(): string {
    const associationName = Utils.singularize(this.options.as);
    if (!associationName) {
      throw new Error('Sanity check: Could not guess the name of the association');
    }

    return Utils.camelize(`${associationName}_${this.attributeReferencedByForeignKey}`);
  }

  /**
   * Get the associated instance.
   *
   * See {@link BelongsToGetAssociationMixinOptions} for a full explanation of options.
   * This method is mixed-in the source model prototype. See {@link BelongsToGetAssociationMixin}.
   *
   * @param instances source instances
   * @param options find options
   */
  // TODO: when is this called with an array? Is it ever?
  async get(instances: S, options: BelongsToGetAssociationMixinOptions): Promise<T | null>;
  async get(instances: S[], options: BelongsToGetAssociationMixinOptions): Promise<Map<any, T | null>>;
  async get(
    instances: S | S[],
    options: BelongsToGetAssociationMixinOptions,
  ): Promise<Map<any, T | null> | T | null> {
    options = Utils.cloneDeep(options);

    let Target = this.target;
    if (options.scope != null) {
      if (!options.scope) {
        Target = Target.unscoped();
      } else if (options.scope !== true) { // 'true' means default scope. Which is the same as not doing anything.
        Target = Target.scope(options.scope);
      }
    }

    if (options.schema != null) {
      Target = Target.schema(options.schema, options.schemaDelimiter);
    }

    let isManyMode = true;
    if (!Array.isArray(instances)) {
      isManyMode = false;
      instances = [instances];
    }

    // FIXME: the scope is ignored
    const where = Object.create(null);

    if (instances.length > 1) {
      where[this.targetKey] = {
        [Op.in]: instances.map(_instance => _instance.get(this.foreignKey)),
      };
    } else {
      const foreignKeyValue = instances[0].get(this.foreignKey);

      if (this.targetKeyIsPrimary && !options.where) {
        return Target.findByPk(
          foreignKeyValue as any,
          options,
        );
      }

      where[this.targetKey] = foreignKeyValue;
      options.limit = null;
    }

    options.where = options.where
      ? { [Op.and]: [where, options.where] }
      : where;

    if (isManyMode) {
      const results = await Target.findAll(options);
      const result: Map<any, T | null> = new Map();

      for (const instance of results) {
        result.set(instance.get(this.targetKey, { raw: true }), instance);
      }

      return result;
    }

    return Target.findOne(options);
  }

  /**
   * Set the associated model.
   *
   * @param sourceInstance the source instance
   * @param associatedInstance An persisted instance or the primary key of an instance to associate with this. Pass `null` to remove the association.
   * @param options options passed to `this.save`
   */
  async set(
    sourceInstance: S,
    associatedInstance: T | T[TargetKey] | null,
    options: BelongsToSetAssociationMixinOptions = {},
  ): Promise<void> {
    let value = associatedInstance;

    if (associatedInstance != null && associatedInstance instanceof this.target) {
      value = (associatedInstance as T)[this.targetKey];
    }

    sourceInstance.set(this.foreignKey, value);

    if (options.save === false) {
      return;
    }

    // passes the changed field to save, so only that field get updated.
    await sourceInstance.save({
      fields: [this.foreignKey],
      // TODO: what is this 'allowNull' for?
      // allowNull: [this.foreignKey],
      association: true,
      ...options,
    });
  }

  /**
   * Create a new instance of the associated model and associate it with this.
   *
   * @param sourceInstance the source instance
   * @param values values to create associated model instance with
   * @param options Options passed to `target.create` and setAssociation.
   *
   * @returns The created target model
   */
  async create(
    sourceInstance: S,
    // @ts-expect-error -- {} is not always assignable to 'values', but Target.create will enforce this, not us.
    values: CreationAttributes<T> = {},
    options: BelongsToCreateAssociationMixinOptions = {},
  ): Promise<T> {
    values = values || {};
    options = options || {};

    const newAssociatedObject = await this.target.create(values, options);
    await this.set(sourceInstance, newAssociatedObject, options);

    return newAssociatedObject;
  }
}

// workaround https://github.com/evanw/esbuild/issues/1260
Object.defineProperty(BelongsTo, 'name', {
  value: 'BelongsTo',
});

export type NormalizedBelongsToOptions<SourceKey extends string, TargetKey extends string> =
  NormalizeBaseAssociationOptions<BelongsToOptions<SourceKey, TargetKey>>;

/**
 * Options provided when associating models with belongsTo relationship
 *
 * @see Association class belongsTo method
 */
export interface BelongsToOptions<SourceKey extends string, TargetKey extends string> extends AssociationOptions<SourceKey> {
  /**
   * The name of the field to use as the key for the association in the target table. Defaults to the primary
   * key of the target table
   */
  targetKey?: TargetKey;

  /**
   * A string or a data type to represent the identifier in the table
   */
  keyType?: DataType;
}

/**
 * The options for the getAssociation mixin of the belongsTo association.
 *
 * @see BelongsToGetAssociationMixin
 */
export interface BelongsToGetAssociationMixinOptions extends FindOptions<any> {
  /**
   * Apply a scope on the related model, or remove its default scope by passing false.
   */
  scope?: string | string[] | boolean;

  /**
   * Apply a schema on the related model
   */
  schema?: string;
  schemaDelimiter?: string;
}

/**
 * The getAssociation mixin applied to models with belongsTo.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsTo(Role);
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttrib>, UserAttrib {
 *  getRole: Sequelize.BelongsToGetAssociationMixin<RoleInstance>;
 *  // setRole...
 *  // createRole...
 * }
 * ```
 *
 * @see Model.belongsTo
 */
// TODO: in the future, type the return value based on whether the foreign key is nullable or not on the source model.
//   if nullable, return TModel | null
//   https://github.com/sequelize/meetings/issues/14
export type BelongsToGetAssociationMixin<TModel extends Model> =
  (options?: BelongsToGetAssociationMixinOptions) => Promise<TModel>;

/**
 * The options for the setAssociation mixin of the belongsTo association.
 *
 * @see BelongsToSetAssociationMixin
 */
export interface BelongsToSetAssociationMixinOptions extends SaveOptions<any> {
  /**
   * Skip saving this after setting the foreign key if false.
   */
  save?: boolean;
}

/**
 * The setAssociation mixin applied to models with belongsTo.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsTo(Role);
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttributes>, UserAttributes {
 *  // getRole...
 *  setRole: Sequelize.BelongsToSetAssociationMixin<RoleInstance, RoleId>;
 *  // createRole...
 * }
 * ```
 *
 * @see Model.belongsTo
 *
 * @typeParam TargetKeyType The type of the attribute that the foreign key references.
 */
export type BelongsToSetAssociationMixin<TModel extends Model, TargetKeyType> = (
  newAssociation?: TModel | TargetKeyType,
  options?: BelongsToSetAssociationMixinOptions
) => Promise<void>;

/**
 * The options for the createAssociation mixin of the belongsTo association.
 *
 * @see BelongsToCreateAssociationMixin
 */
export interface BelongsToCreateAssociationMixinOptions
  extends CreateOptions<any>, BelongsToSetAssociationMixinOptions {}

/**
 * The createAssociation mixin applied to models with belongsTo.
 * An example of usage is as follows:
 *
 * ```js
 *
 * User.belongsTo(Role);
 *
 * interface UserInstance extends Sequelize.Instance<UserInstance, UserAttributes>, UserAttributes {
 *  // getRole...
 *  // setRole...
 *  createRole: Sequelize.BelongsToCreateAssociationMixin<RoleAttributes>;
 * }
 * ```
 *
 * @see Model.belongsTo
 */
export type BelongsToCreateAssociationMixin<TModel extends Model> = (
  values?: CreationAttributes<TModel>,
  options?: BelongsToCreateAssociationMixinOptions
) => Promise<TModel>;
