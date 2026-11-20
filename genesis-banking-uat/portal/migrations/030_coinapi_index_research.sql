-- CoinAPI benchmark research data: independent of custody, order execution and INDEX advice.
-- Observations and completed OHLC bars remain available as historical evidence.
CREATE TABLE avis_core_v2.coinapi_index_observations (
 index_id varchar(120) NOT NULL,
 source_at timestamptz NOT NULL,
 value numeric(38,18) NOT NULL CHECK (value>0),
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (index_id,source_at)
);
CREATE INDEX coinapi_index_observations_recent ON avis_core_v2.coinapi_index_observations (source_at DESC);
CREATE TRIGGER coinapi_index_observations_immutable BEFORE UPDATE OR DELETE
 ON avis_core_v2.coinapi_index_observations FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();

CREATE TABLE avis_core_v2.coinapi_index_bars (
 index_id varchar(120) NOT NULL,
 period_id varchar(12) NOT NULL CHECK (period_id='1DAY'),
 period_start timestamptz NOT NULL,
 period_end timestamptz NOT NULL,
 value_open numeric(38,18) NOT NULL CHECK(value_open>0),
 value_high numeric(38,18) NOT NULL CHECK(value_high>0),
 value_low numeric(38,18) NOT NULL CHECK(value_low>0),
 value_close numeric(38,18) NOT NULL CHECK(value_close>0),
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (index_id,period_id,period_start),
 CHECK(period_end>period_start),
 CHECK(value_high>=GREATEST(value_open,value_close,value_low)),
 CHECK(value_low<=LEAST(value_open,value_close,value_high))
);
CREATE INDEX coinapi_index_bars_recent ON avis_core_v2.coinapi_index_bars (period_start DESC);
CREATE TRIGGER coinapi_index_bars_immutable BEFORE UPDATE OR DELETE
 ON avis_core_v2.coinapi_index_bars FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
