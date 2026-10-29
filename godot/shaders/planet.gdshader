shader_type spatial;
render_mode diffuse_burley, specular_schlick_ggx;
uniform sampler2D height_map : filter_linear, repeat_disable;
uniform sampler2D forage_map : filter_nearest, repeat_disable;
uniform sampler2D habitat_map : filter_linear, repeat_disable;
uniform sampler2D weather_map : filter_nearest, repeat_disable;
uniform sampler2D temperature_map : filter_nearest, repeat_disable;
uniform float sea_level = 0.42;
uniform float temperature = 18.0;
uniform float rainfall = 0.65;
uniform int layer = 0;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
void fragment() {
    vec2 uv=vec2(fract(UV.x),clamp(UV.y,0.001,0.999));
    float h=texture(height_map,uv).r;
    vec4 habitat=texture(habitat_map,uv);
    float food=habitat.r, cover=habitat.g, soil=habitat.b;
    vec2 forage=texture(forage_map,uv).rg;
    vec2 weather=texture(weather_map,uv).rg;
    float moisture=weather.r;
    float t=temperature-12.0*abs(uv.y*2.0-1.0)+texture(temperature_map,uv).r;
    float grain=noise(uv*vec2(530.0,265.0))*0.6+noise(uv*vec2(1470.0,735.0))*0.4;
    vec3 color;
    if(h<=sea_level) {
        float depth=smoothstep(sea_level-0.22,sea_level,h);
        color=mix(vec3(0.018,0.075,0.16),vec3(0.04,0.44,0.48),depth);
        float wave=sin(UV.x*1300.0+TIME*1.4)*sin(UV.y*780.0-TIME*0.8);
        color*=0.97+0.035*wave;
        ROUGHNESS=0.22; SPECULAR=0.9;
    } else {
        color=mix(vec3(0.37,0.34,0.18),vec3(0.29,0.48,0.24),food);
        color=mix(color,vec3(0.045,0.20,0.13),smoothstep(0.10,0.75,forage.r));
        if(moisture<0.18 || soil<0.18) color=mix(vec3(0.55,0.32,0.16),vec3(0.78,0.62,0.35),grain);
        float mountain=smoothstep(0.17,0.32,h-sea_level);
        color=mix(color,vec3(0.37,0.40,0.38),mountain);
        float snow=(1.0-smoothstep(-8.0,2.0,t-(h-sea_level)*38.0));
        color=mix(color,vec3(0.80,0.89,0.90),snow);
        float beach=1.0-smoothstep(0.006,0.032,h-sea_level);
        color=mix(color,vec3(0.69,0.66,0.43),beach);
        color*=(0.88+grain*0.22)*(1.0-moisture*0.18);
        ROUGHNESS=0.88; SPECULAR=0.18;
        if(layer==7) color=mix(vec3(0.20,0.16,0.10),vec3(0.12,0.65,0.32),forage.r);
        if(layer==8) color=mix(vec3(0.17,0.14,0.12),vec3(1.0,0.72,0.15),forage.g);
        if(layer==1) color=mix(vec3(0.28,0.12,0.07),vec3(0.62,0.88,0.26),food);
        if(layer==3) color=mix(vec3(0.07,0.13,0.10),vec3(0.95,0.47,0.22),clamp(habitat.a*3.0,0.0,1.0));
        if(layer==5) color=mix(vec3(0.72,0.36,0.12),vec3(0.08,0.55,0.78),moisture);
        if(layer==4) color=mix(vec3(0.42,0.20,0.09),vec3(0.38,0.84,0.48),soil);
    }
    if(layer==2) color=mix(vec3(0.12,0.40,0.80),vec3(0.90,0.27,0.10),clamp((t+15.0)/60.0,0.0,1.0));
    if(layer==6) color=mix(vec3(0.13,0.15,0.20),vec3(0.20,0.75,1.0),weather.g);
    ALBEDO=color;
}
