"""Owner specification v5: 250-tick L1 -> neckline -> L2 -> breakout.
NautilusTrader supplies typed ticks and IOC orders; AVIS handles durable execution.
"""
import hashlib
import math
import statistics
from collections import deque
from decimal import Decimal, ROUND_DOWN
from nautilus_trader.trading.strategy import Strategy
from nautilus_trader.config import StrategyConfig
from nautilus_trader.common.factories import OrderFactory
from nautilus_trader.common.component import LiveClock
from nautilus_trader.model.data import QuoteTick
from nautilus_trader.model.identifiers import InstrumentId, TraderId, StrategyId
from nautilus_trader.model.enums import OrderSide, TimeInForce
from nautilus_trader.model.objects import Price, Quantity


def validate_w(ticks):
    if len(ticks) != 250:
        return None
    if ticks[-1]['tsMicros'] - ticks[0]['tsMicros'] > 3_600_000_000:
        return None
    mids = [(t['bid'] + t['ask']) / 2 for t in ticks]
    l1i = min(range(20, 80), key=lambda i: mids[i])
    ni = max(range(80, 160), key=lambda i: mids[i])
    l2i = min(range(160, 240), key=lambda i: mids[i])
    l1, neck, l2, cur = mids[l1i], mids[ni], mids[l2i], mids[-1]
    before = mids[max(0, l1i-40):l1i]
    std = statistics.pstdev(before)
    z = (l1 - statistics.mean(before)) / std if std > 0 else 0
    sell1 = sum(t['sellVolume'] for t in ticks[max(0,l1i-4):l1i+5])
    sell2 = sum(t['sellVolume'] for t in ticks[l2i-4:l2i+5])
    baseline = statistics.mean(t['sellVolume'] for t in ticks[:max(1,l1i-4)]) * 9
    imbalance = ticks[-1]['bidSize'] / ticks[-1]['askSize']
    spread = (ticks[-1]['ask'] - ticks[-1]['bid']) / cur
    if not (z < -2.2 and sell1 > max(baseline * 1.5, 0) and sell2 < sell1):
        return None
    if not (abs(l2-l1)/l1 <= .0035 and l2 >= l1*.998 and (neck-l1)/l1 >= .004):
        return None
    if not (cur > neck and cur > mids[-2] and imbalance >= 1.65 and spread <= .0035):
        return None
    return dict(l1=l1,neckline=neck,l2=l2,zScore=z,sellVolumeL1=sell1,sellVolumeL2=sell2,
                imbalance=imbalance,spread=spread,l1Time=ticks[l1i]['tsMicros'],l2Time=ticks[l2i]['tsMicros'])


def index_allows(index, instrument_id, now_ms, minimum=0):
    if not index or index.get('instrumentId') != instrument_id:
        return False
    numbers = [index.get('score'), index.get('confidence'), index.get('validUntilMs'), index.get('generatedAtMs')]
    if any(not isinstance(n,(float,int)) or not math.isfinite(n) for n in numbers):
        return False
    return (index['score'] >= minimum and index['confidence'] >= .2 and index.get('sourceCount',0) >= 2
            and index['validUntilMs'] > now_ms and 0 <= now_ms-index['generatedAtMs'] <= 180_000)


class WEffectStrategy(Strategy):
    def __init__(self, settings):
        super().__init__(StrategyConfig(strategy_id='WEFFECT-001'))
        self.settings = settings
        self.ticks = deque(maxlen=250)
        self.factory = OrderFactory(TraderId('AVIS-001'), StrategyId('WEFFECT-001'), LiveClock())
        self.instrument = InstrumentId.from_str(settings['symbol']+'.'+settings['venue'])
        self.index = None
        self.event_advice = []
        self.position = float(settings.get('positionQuantity',0))
        self.stop = float(settings.get('stopPrice',0))
        self.peak = float(settings.get('peakPrice',0))
        self.pending = False
        self.last_attempt = 0
        self.last_ts = 0
        self.result = None

    def receive(self, raw, now_ms):
        required=['bid','ask','bidSize','askSize','sellVolume','tsMicros']
        if any(not isinstance(raw.get(k),(float,int)) or not math.isfinite(raw[k]) for k in required):
            return None
        if min(raw['bid'],raw['ask'],raw['bidSize'],raw['askSize']) <= 0 or raw['sellVolume'] < 0 or raw['bid'] > raw['ask']:
            return None
        if raw['tsMicros'] <= self.last_ts or not 0 <= now_ms*1000-raw['tsMicros'] <= 5_000_000:
            return None
        self.last_ts=raw['tsMicros']; self.raw=raw; self.now_ms=now_ms; self.result=None
        precision=max(-Decimal(str(raw['bid'])).as_tuple().exponent,-Decimal(str(raw['ask'])).as_tuple().exponent)
        size_precision=max(-Decimal(str(raw['bidSize'])).as_tuple().exponent,-Decimal(str(raw['askSize'])).as_tuple().exponent)
        tick = QuoteTick(self.instrument,Price.from_str(format(raw['bid'],f'.{precision}f')),Price.from_str(format(raw['ask'],f'.{precision}f')),
                         Quantity.from_str(format(raw['bidSize'],f'.{size_precision}f')),Quantity.from_str(format(raw['askSize'],f'.{size_precision}f')),
                         int(raw['tsMicros']*1000),int(now_ms*1_000_000))
        self.on_quote_tick(tick)
        return self.result

    def on_quote_tick(self, tick):
        self.ticks.append(self.raw)
        if self.pending or self.now_ms-self.last_attempt < 5000:
            return
        pattern=None; side='BUY'
        if self.position > 0:
            self.peak=max(self.peak,self.raw['bid'])
            self.stop=max(self.stop,self.peak*(1-float(self.settings.get('trailingBps',50))/10000))
            if self.raw['bid'] > self.stop:
                return
            side='SELL'; quantity=Decimal(str(self.position))
        else:
            if self.settings.get('enabled') is False:
                return
            pattern=validate_w(list(self.ticks))
            if not pattern or not index_allows(self.index,self.settings['indexId'],self.now_ms,float(self.settings.get('minimumIndex',0))):
                return
            quantity=Decimal(str(self.settings['maxNotional']))/(Decimal(str(self.raw['ask']*1.0005))*Decimal(str(self.settings.get('priceMultiplier',1))))
        step=Decimal(str(self.settings['quantityStep'])); quantity=(quantity/step).to_integral_value(rounding=ROUND_DOWN)*step
        if quantity<=0:
            return
        price=Decimal(str(self.raw['ask']*1.0005 if side=='BUY' else self.raw['bid']*.9995))
        tick_size=Decimal(str(self.settings['priceTick'])); price=(price/tick_size).to_integral_value(rounding=ROUND_DOWN)*tick_size
        order=self.factory.limit(instrument_id=self.instrument,order_side=OrderSide.BUY if side=='BUY' else OrderSide.SELL,
                                 quantity=Quantity.from_str(format(quantity,'f')),price=Price.from_str(format(price,'f')),time_in_force=TimeInForce.IOC)
        self.pending=True; self.last_attempt=self.now_ms
        signal_key=(self.settings['id'],side,pattern['l1Time'],pattern['l2Time']) if pattern else (self.settings['id'],side,self.raw['tsMicros'])
        self.result={'type':'ORDER','robotId':self.settings['id'],'signalId':hashlib.sha256(str(signal_key).encode()).hexdigest(),
                     'order':order.to_dict(),'side':side,'quantity':str(quantity),'price':str(price),'pattern':pattern,
                     'indexSequence':self.index.get('sequence') if self.index else None,'tickTime':self.raw['tsMicros'],
                     'eventSignalIds':[c['signalId'] for c in self.event_advice if c.get('action')==side and c.get('expiresAtMs',0)>self.now_ms][:20],
                     'stopPrice':pattern['l2']*.999 if pattern else self.stop,'peakPrice':self.peak,'engine':'NautilusTrader 1.231.0'}

    def acknowledge(self, state):
        self.position=float(state.get('positionQuantity',self.position));self.stop=max(self.stop,float(state.get('stopPrice',self.stop))) if self.position else 0;self.peak=max(self.peak,float(state.get('peakPrice',self.peak))) if self.position else 0;self.pending=False
