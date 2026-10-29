shader_type spatial;
uniform bool tail=false;
varying float shell_strength;
varying float vitality;
void vertex() {
    float phase=INSTANCE_CUSTOM.r*6.283185;
    float motion=clamp(INSTANCE_CUSTOM.a,0.0,1.0);
    shell_strength=INSTANCE_CUSTOM.b;
    vitality=INSTANCE_CUSTOM.g;
    // Phase is advanced by the view only while running: pause freezes geometry.
    if(tail) VERTEX.x+=sin(phase+VERTEX.y*3.0)*(0.08+motion*0.55);
    else VERTEX+=NORMAL*sin(phase)*(0.008+motion*0.017);
}
void fragment() {
    float spots=sin(UV.x*28.0)*sin(UV.y*20.0);
    ALBEDO=COLOR.rgb*(0.88+spots*0.08);
    float plates=smoothstep(0.65,0.9,abs(sin(UV.x*24.0)));
    ALBEDO=mix(ALBEDO,ALBEDO*0.6+vec3(0.19,0.23,0.24)*plates,shell_strength*0.7);
    ALBEDO*=mix(0.65,1.0,clamp(vitality,0.0,1.0));
    ROUGHNESS=tail ? 0.45 : mix(0.27,0.62,shell_strength);
    SPECULAR=0.65;
    EMISSION=COLOR.rgb*0.035;
}
