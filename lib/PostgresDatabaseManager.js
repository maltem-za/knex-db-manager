var _ = require('lodash')
  , pg = require('pg')
  , escape = require('pg-escape')
  , Promise = require('bluebird')
  , classUtils = require('./class-utils')
  , DatabaseManager = require('./DatabaseManager').default;

/**
 * @constructor
 */
function PostgresDatabaseManager() {
  DatabaseManager.apply(this, arguments);
  this._masterClient = null;
  this._cachedTableNames = null;
  this._cachedIdSequences = null;
}

classUtils.inherits(PostgresDatabaseManager, DatabaseManager);

/**
 * @Override
 */
PostgresDatabaseManager.prototype.createDbOwnerIfNotExist = function() {
  return this._masterQuery("DO $body$ BEGIN CREATE ROLE %I LOGIN PASSWORD %L; EXCEPTION WHEN others THEN RAISE NOTICE 'User exists, not re-creating'; END $body$;", [this.config.knex.connection.user, this.config.knex.connection.password])
};

/** 
 * @Override
 */
PostgresDatabaseManager.prototype.createDb = function(databaseName) {
  databaseName = databaseName || this.config.knex.connection.database;
  var collate = this.config.dbManager.collate;
  var owner = this.config.knex.connection.user;
  var self = this;
  var promise = Promise.reject();

  if (_.isEmpty(collate)) {
    promise = promise.catch(function () {
      return self._masterQuery("CREATE DATABASE %I OWNER = %I ENCODING = 'UTF-8' TEMPLATE template1", [databaseName, owner]);
    });
  } else {
    // Try to create with each collate. Use the first one that works. This is kind of a hack
    // but seems to be the only reliable way to make this work with both windows and unix.
    _.each(collate, function(locale) {
      promise = promise.catch(function() {
        return self._masterQuery("CREATE DATABASE %I OWNER = %I ENCODING = 'UTF-8' LC_COLLATE = %L TEMPLATE template0", [databaseName, owner, locale]);
      });
    });
  }

  return promise ;
};

/**
 * Drops database with name if db exists.
 *
 * @Override
 */
PostgresDatabaseManager.prototype.dropDb = function(databaseName) {
  var self = this;
  databaseName = databaseName || this.config.knex.connection.database;
  return this.closeKnex()
    .then(function () {
      return self._masterQuery("DROP DATABASE IF EXISTS %I", [databaseName]);
    });
};

/**
 * @Override
 */
PostgresDatabaseManager.prototype.copyDb = function(fromDatabaseName, toDatabaseName) {
  var self = this;
  return this.closeKnex()
    .then(function () {
      return self._masterQuery("CREATE DATABASE %I template %I", [toDatabaseName, fromDatabaseName]);
    });
};

/**
 * @Override
 */
PostgresDatabaseManager.prototype.truncateDb = function(ignoreTables) {
  var knex = this.knexInstance();
  var config = this.config;

  if (!this._cachedTableNames) {
    this._updateTableNameCache(knex, config);
  }

  return this._cachedTableNames.then(function (tableNames) {
    var filteredTableNames = _.filter(tableNames, function (tableName) {
      return !_.includes(ignoreTables || [], tableName);
    });
    if (!_.isEmpty(filteredTableNames)) {
      return knex.raw('TRUNCATE TABLE "' + filteredTableNames.join('","') + '" RESTART IDENTITY');
    }
  });
};

/**
 * @Override
 */
PostgresDatabaseManager.prototype.updateIdSequences = function() {
  var knex = this.knexInstance();
  var config = this.config;

  if (!this._cachedIdSequences) {
    this._updateIdSequenceCache(knex, config);
  }

  // Set current value of id sequence for each table.
  // If there are no rows in the table, the value will be set to sequence's minimum constraint.
  // Otherwise, it will be set to max(id) + 1.
  return this._cachedIdSequences.then(function (result) {
    var query = _.map(result.rows, function (row) {
      return escape("SELECT setval('%s', GREATEST(coalesce(max(id),0) + 1, '%s'), false) FROM \"%I\"",
                    row.sequence, row.min, row.table);
    });

    query = query.join(' UNION ALL ') + ';';
    return knex.raw(query);
  });
};

/**
 * @private
 */
PostgresDatabaseManager.prototype._updateTableNameCache = function(knex, config) {
  this._cachedTableNames = knex('pg_tables').select('tablename').where('schemaname', 'public').then(function (tables) {
    return _.map(tables, 'tablename');
  });
};

/**
 * Id sequence cache holds a Promise, that returns following objects:
 * {
 *   table: String, // Table that rest of the values target
 *   sequence: String, // Sequence for the primary key (which is assumed to be id)
 *   min: String // Minimum allowed value for the sequence
 * }
 *
 * These values are cached because they are not expected to change often,
 * and finding them is slow.
 *
 * @private
 */
PostgresDatabaseManager.prototype._updateIdSequenceCache = function(knex, config) {
  if (!this._cachedTableNames) {
    this._updateTableNameCache(knex, config);
  }

  this._cachedIdSequences = this._cachedTableNames.then(function (tableNames) {
    // Skip tables without id column.
    return knex('information_schema.columns')
      .select('table_name')
      .where('column_name', 'id')
      .then(function (tables) {
        return _.intersection(_.map(tables, 'table_name'), tableNames);
      });
  // Find name of the id sequence for each table.
  // This is required for searching the minimum constraint for the sequence.
  }).then(function (idTableNames) {
    var query = _.map(idTableNames, function (tableName) {
      return escape("SELECT '%I' AS table, pg_get_serial_sequence('\"%I\"', 'id') AS sequence",
                    tableName, tableName);
    });

    query = query.join(' UNION ALL ') + ';';
    return knex.raw(query);
  // Find min constraint for each of the id sequences.
  }).then(function (result) {
    // Find the server version so that we can generate valid SQL
    return knex.raw('SHOW server_version_num;').then(function (versionResult) {
      var serverVersionNum = parseInt(versionResult.rows[0].server_version_num, 10);
      if (serverVersionNum >= 100000) {
        var query = _.map(result.rows, function (row) {
          // https://stackoverflow.com/questions/47551628/postgresql-sequence-getting-max-value
          return escape("SELECT '%I' AS table, '%s' AS sequence, (SELECT seqmin FROM pg_sequence WHERE seqrelid = '%s'::regclass) AS min",
                        row.table, row.sequence, row.sequence);
        });
      }
      else {
        var query = _.map(result.rows, function (row) {
          return escape("SELECT '%I' AS table, '%s' AS sequence, min_value AS min FROM %s",
                        row.table, row.sequence, row.sequence);
        });
      }

      query = query.join(' UNION ALL ') + ';';
      return knex.raw(query);
    });
  });
};

/**
 * @Override
 */
PostgresDatabaseManager.prototype.close = function() {
  var disconnectAll = [this.closeKnex()];
  if (this._masterClient) {
    disconnectAll.push(this._masterClient.then(function(client) {
      client.end();
    }));
    this._masterClient = null;
  }
  return Promise.all(disconnectAll);
};

/**
 * @private
 * @returns {Promise}
 */
PostgresDatabaseManager.prototype._masterQuery = function(query, params) {
  var self = this;
  if (!this._masterClient) {
    this._masterClient = this.create_masterClient();
  }
  return this._masterClient.then(function(client) {
    return self.perform_masterQuery(client, query, params);
  });
};

/**
 * @private
 * @returns {Promise}
 */
PostgresDatabaseManager.prototype.create_masterClient = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    var client = new pg.Client(self._masterConnectionUrl());
    client.connect(function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(client);
      }
    });
  });
};

/**
 * @private
 * @returns {Promise}
 */
PostgresDatabaseManager.prototype.perform_masterQuery = function(client, query, params) {
  return new Promise(function(resolve, reject) {
    if (params) {
      var args = [query].concat(params);
      query = escape.apply(global, args);
    }
    client.query(query, function(err, result) {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
};

/**
 * @private
 * @returns {String}
 */
PostgresDatabaseManager.prototype._masterConnectionUrl = function() {
  var url = 'postgres://';
  if (this.config.dbManager.superUser) {
    url += this.config.dbManager.superUser;
  } else {
    throw new Error('DatabaseManager: database config must have `superUser`');
  }
  if (this.config.dbManager.superPassword) {
    url += ':' + this.config.dbManager.superPassword
  }
  var port = this.config.knex.connection.port || 5432;
  url += '@' + this.config.knex.connection.host + ':' + port + '/postgres';
  return url;
};

module.exports = {
  default: PostgresDatabaseManager,
  PostgresDatabaseManager: PostgresDatabaseManager
};
